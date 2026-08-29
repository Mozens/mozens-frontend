// supabase/functions/create-payment/index.ts
//
// VERSI FINAL & HARDENED — Zero Trust Architecture
// Seluruh kalkulasi harga, stok, ongkir, dan fee BICH 100% diverifikasi server-side.
// Mendukung jalur Payment Gateway (iPaymu) dan WhatsApp Manual.
//
// Perubahan hardening (lihat migration_stok_dan_idempotency.sql - WAJIB
// dijalankan dulu sebelum deploy versi ini):
//  1. Stok direservasi ATOMIC lewat RPC reserve_stok_produk (row lock +
//     decrement dalam satu transaksi DB) - menutup race condition oversell
//     dari cek stok "baca lalu bandingkan" yang lama.
//  2. Kompensasi (release_stok_produk) dipanggil kalau langkah setelah
//     reservasi gagal (insert pesanan gagal / iPaymu gagal) - stok gak
//     nyangkut kepotong tanpa pesanan yang valid.
//  3. Idempotency: kalau klien kirim idempotency_key eksplisit, atau tidak,
//     fingerprint otomatis dari isi request + jendela waktu 60 detik dipakai
//     buat cegah double-submit (double klik / retry jaringan) bikin 2 pesanan.
//  4. Semua pesan error dari Supabase/exception internal TIDAK diteruskan
//     mentah ke klien - dicatat di server log, klien dapat pesan generik.
//  5. Validasi input pelanggan (nama/email/telepon/alamat) + batas qty &
//     jumlah item per keranjang.
//  6. Pesanan gateway yang gagal dibuat di iPaymu ditandai status 'Gagal'
//     (bukan dibiarkan nyangkut 'Pending' selamanya) dan stoknya dilepas.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("MOZENS_SERVICE_ROLE_KEY")!;

const IPAYMU_VA = Deno.env.get("IPAYMU_VA")!;
const IPAYMU_API_KEY = Deno.env.get("IPAYMU_API_KEY")!;
const IPAYMU_ENV = Deno.env.get("IPAYMU_ENV") || "sandbox";

const ADMIN_WA_NUMBER = "6282341333313";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// --- Batas wajar input, cegah abuse & payload sampah ---
const QTY_MIN = 1;
const QTY_MAX = 500;
const MAX_ITEMS_PER_CART = 50;
const NAME_MIN = 2, NAME_MAX = 100;
const ADDRESS_MIN = 5, ADDRESS_MAX = 500;
const EMAIL_MAX = 254;
const IDEMPOTENCY_WINDOW_MS = 60_000; // jendela fallback fingerprint kalau klien tidak kirim key sendiri

// ============================================================================
// Helper: response generik, error detail dicatat server-side saja
// ============================================================================
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// clientMsg = pesan aman yang sudah kita tulis sendiri (boleh ditampilkan).
// internalErr = detail asli (Supabase error, exception, dll) - HANYA di-log,
// tidak pernah ikut ke response.
function safeError(clientMsg: string, status: number, internalErr?: unknown) {
  if (internalErr !== undefined) {
    console.error(`[create-payment] ${clientMsg} | detail:`, internalErr);
  }
  return json({ error: clientMsg }, status);
}

// ============================================================================
// Helper: validasi input pelanggan
// ============================================================================
function isNonEmptyString(s: unknown, min: number, max: number): s is string {
  return typeof s === "string" && s.trim().length >= min && s.trim().length <= max;
}

function isValidEmail(email: string): boolean {
  return email.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/[^\d]/g, "");
  return digits.length >= 9 && digits.length <= 15;
}

// ============================================================================
// Helper: idempotency fingerprint (fallback kalau klien tidak kirim key)
// ============================================================================
async function buatFingerprint(payload: object, timeBucket: number): Promise<string> {
  const encoder = new TextEncoder();
  const raw = JSON.stringify(payload) + ":" + timeBucket;
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(raw));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// Helper: iPaymu signature & format
// ============================================================================
async function generateIPaymuSignature(va: string, apiKey: string, bodyObj: object): Promise<string> {
  const bodyJson = JSON.stringify(bodyObj);
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(bodyJson));
  const bodyHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("").toLowerCase();
  const stringToSign = `POST:${va}:${bodyHash}:${apiKey}`;
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(stringToSign));
  return Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("").toLowerCase();
}

function formatRupiah(angka: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(angka || 0);
}

// rpc() mengembalikan PostgrestFilterBuilder (thenable), bukan Promise asli -
// tidak punya method .catch(). Dibungkus try/catch biasa di sini.
async function rilisStokAman(items: Array<{ id: string | number; qty: number }>, konteks: string) {
  try {
    await supabaseAdmin.rpc("release_stok_produk", { p_items: items });
  } catch (e) {
    console.error(`[create-payment] Gagal release stok (${konteks}):`, e);
  }
}

function formatTimestampIPaymu(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// ============================================================================
// Handler utama
// ============================================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Dipakai buat kompensasi kalau ada kegagalan setelah stok direservasi.
  let stokSudahDireservasi = false;
  let itemsUntukRilis: Array<{ id: string | number; qty: number }> = [];

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return safeError("Body request tidak valid (harus JSON).", 400);
    }

    const {
      items,
      customer_name,
      customer_email,
      customer_phone,
      shipping_address,
      kota_tujuan,
      shipping_method,
      payment_method,
      return_url,
      idempotency_key: idempotencyKeyDariKlien,
    } = body as {
      items?: Array<{ id: string | number; qty?: number | string }>;
      customer_name?: string;
      customer_email?: string;
      customer_phone?: string;
      shipping_address?: string;
      kota_tujuan?: string;
      shipping_method?: string;
      payment_method?: string;
      return_url?: string;
      idempotency_key?: string;
    };

    // ------------------------------------------------------------------
    // 0. Validasi input dasar
    // ------------------------------------------------------------------
    if (!items || !Array.isArray(items) || items.length === 0) {
      return safeError("Keranjang kosong atau format tidak valid.", 400);
    }
    if (items.length > MAX_ITEMS_PER_CART) {
      return safeError(`Keranjang maksimal ${MAX_ITEMS_PER_CART} item berbeda.`, 400);
    }
    if (!isNonEmptyString(kota_tujuan, 1, 100) || !isNonEmptyString(shipping_method, 1, 100)) {
      return safeError("Kota tujuan & metode pengiriman wajib diisi.", 400);
    }
    if (!isNonEmptyString(customer_name, NAME_MIN, NAME_MAX)) {
      return safeError(`Nama penerima wajib diisi (${NAME_MIN}-${NAME_MAX} karakter).`, 400);
    }
    if (!isNonEmptyString(customer_phone, 1, 20) || !isValidPhone(customer_phone as string)) {
      return safeError("Nomor WhatsApp tidak valid.", 400);
    }
    if (!isNonEmptyString(shipping_address, ADDRESS_MIN, ADDRESS_MAX)) {
      return safeError(`Alamat pengiriman wajib diisi (${ADDRESS_MIN}-${ADDRESS_MAX} karakter).`, 400);
    }
    if (customer_email !== undefined && customer_email !== null && customer_email !== "" && !isValidEmail(String(customer_email))) {
      return safeError("Format email tidak valid.", 400);
    }
    if (payment_method !== undefined && payment_method !== "manual" && payment_method !== "gateway") {
      return safeError("Metode pembayaran tidak dikenali.", 400);
    }

    // Validasi & normalisasi qty tiap item - integer positif dalam batas wajar.
    // (Number(-5) / NaN lolos truthy check kalau tidak divalidasi eksplisit.)
    const itemsQtyMap = new Map<string, number>();
    for (const it of items) {
      if (it?.id === undefined || it?.id === null) {
        return safeError("Setiap item wajib punya id produk.", 400);
      }
      const qty = Number(it.qty ?? 1);
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < QTY_MIN || qty > QTY_MAX) {
        return safeError(`Kuantitas tidak valid untuk produk ${it.id}.`, 400);
      }
      itemsQtyMap.set(String(it.id), qty);
    }

    // ------------------------------------------------------------------
    // 1. Ambil harga ASLI dari Database (Garis Pertahanan Utama Security)
    // ------------------------------------------------------------------
    const productIds = [...itemsQtyMap.keys()];
    const { data: produkAsli, error: errProduk } = await supabaseAdmin
      .from("bich_produk")
      .select("id, nama_produk, harga, stok")
      .in("id", productIds);

    if (errProduk) {
      return safeError("Gagal verifikasi produk. Coba beberapa saat lagi.", 500, errProduk);
    }

    type ProdukRow = { id: string | number; nama_produk: string; harga: number; stok: number | null };

    const produkMap = new Map<string, ProdukRow>(
      ((produkAsli || []) as ProdukRow[]).map((p) => [String(p.id), p])
    );

    // Cross-check: semua id yang dikirim klien harus ketemu di DB, jangan
    // diam-diam di-skip (itemsTervalidasi harus persis selengkap request).
    let subtotal = 0;
    const itemsTervalidasi: Array<{ id: string | number; nama_produk: string; harga: number; qty: number }> = [];

    for (const [idStr, qty] of itemsQtyMap) {
      const asli = produkMap.get(idStr);
      if (!asli) {
        return safeError(`Produk ID ${idStr} tidak ditemukan.`, 400);
      }
      subtotal += asli.harga * qty;
      itemsTervalidasi.push({
        id: asli.id,
        nama_produk: asli.nama_produk,
        harga: asli.harga,
        qty,
      });
    }

    // ------------------------------------------------------------------
    // 1b. Validasi ulang ongkir lewat hitung-ongkir (Server-to-Server)
    // ------------------------------------------------------------------
    let ongkirResp: Response;
    try {
      ongkirResp = await fetch(`${SUPABASE_URL}/functions/v1/hitung-ongkir`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          kota_tujuan,
          items: itemsTervalidasi.map((i) => ({ produk_id: i.id, qty: i.qty })),
        }),
      });
    } catch (fetchErr) {
      return safeError("Layanan hitung ongkir sedang bermasalah. Coba beberapa saat lagi.", 502, fetchErr);
    }

    if (!ongkirResp.ok) {
      return safeError("Layanan hitung ongkir sedang bermasalah. Coba beberapa saat lagi.", 502, `HTTP ${ongkirResp.status}`);
    }

    const ongkirData = await ongkirResp.json();

    // Kalau hitung-ongkir kasih alasan spesifik (mis. keranjang multi-origin),
    // teruskan pesan itu apa adanya - jangan ditelan jadi pesan generik yang
    // bikin pembeli bingung harus ngapain. Pesan ini sudah aman (ditulis kita
    // sendiri di hitung-ongkir, bukan bocoran internal).
    if (ongkirData?.error) {
      return json({ error: ongkirData.message || ongkirData.error }, 400);
    }

    const opsiSah = (ongkirData.opsi || []).find((o: { kode: string }) => o.kode === shipping_method);

    if (!opsiSah) {
      return safeError("Metode pengiriman tidak valid untuk tujuan ini. Muat ulang halaman checkout.", 400);
    }
    const ongkir = opsiSah.harga;
    const feeBich = Math.floor(subtotal * 0.025);
    const totalAmount = subtotal + ongkir + feeBich;
    const nomorPesanan = `BM-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const metodePembayaranLabel = payment_method === "manual" ? "WhatsApp Manual" : "iPaymu QRIS/VA";

    // ------------------------------------------------------------------
    // 1c. Idempotency - cegah double-submit bikin 2 pesanan terpisah
    // ------------------------------------------------------------------
    let idempotencyKey: string;
    if (isNonEmptyString(idempotencyKeyDariKlien, 8, 200)) {
      // Klien (checkout.html) sudah/akan kirim key sendiri per sesi checkout - dipakai apa adanya.
      idempotencyKey = idempotencyKeyDariKlien as string;
    } else {
      // Fallback otomatis: fingerprint dari isi keranjang + pembeli + jendela
      // waktu 60 detik. Tidak butuh perubahan di frontend, tapi cakupannya
      // terbatas ke jendela waktu ini saja (retry setelah 60 detik dianggap
      // pesanan baru yang sah, bukan double-submit).
      const timeBucket = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
      idempotencyKey = await buatFingerprint(
        { customer_phone, kota_tujuan, shipping_method, items: [...itemsQtyMap.entries()].sort() },
        timeBucket
      );
    }

    const { data: pesananLama } = await supabaseAdmin
      .from("bich_pesanan")
      .select("id, nomor_pesanan, status, total_harga")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (pesananLama) {
      // Sudah ada pesanan dari request yang sama (double klik / retry jaringan) -
      // jangan bikin baru, jangan reservasi stok lagi. Kembalikan info yang sudah ada.
      return json({
        order_id: pesananLama.id,
        nomor_pesanan: pesananLama.nomor_pesanan,
        status: pesananLama.status,
        total_validated: pesananLama.total_harga,
        catatan: "Pesanan dengan permintaan yang sama sudah pernah dibuat sebelumnya.",
      });
    }

    // ------------------------------------------------------------------
    // 1d. Reservasi stok ATOMIC (lock + decrement dalam satu transaksi DB)
    //     Kalau produk manapun stoknya kurang, RPC ini melempar exception
    //     dan TIDAK ADA stok manapun yang berubah (all-or-nothing).
    // ------------------------------------------------------------------
    itemsUntukRilis = itemsTervalidasi.map((i) => ({ id: i.id, qty: i.qty }));

    const { error: errReservasi } = await supabaseAdmin.rpc("reserve_stok_produk", {
      p_items: itemsTervalidasi.map((i) => ({ id: i.id, qty: i.qty })),
    });

    if (errReservasi) {
      const pesan = errReservasi.message || "";
      if (pesan.includes("STOK_TIDAK_CUKUP")) {
        const idGagal = pesan.split(":")[1]?.trim();
        const nama = itemsTervalidasi.find((i) => String(i.id) === idGagal)?.nama_produk || `ID ${idGagal}`;
        return safeError(`Stok "${nama}" tidak mencukupi.`, 409, errReservasi);
      }
      if (pesan.includes("PRODUK_TIDAK_DITEMUKAN")) {
        return safeError("Salah satu produk di keranjang sudah tidak tersedia.", 409, errReservasi);
      }
      return safeError("Gagal memproses stok. Coba beberapa saat lagi.", 500, errReservasi);
    }
    stokSudahDireservasi = true;

    // ------------------------------------------------------------------
    // 2. Simpan pesanan ke Database Supabase (Status: Pending)
    // ------------------------------------------------------------------
    const { data: pesanan, error: errInsert } = await supabaseAdmin
      .from("bich_pesanan")
      .insert([{
        nomor_pesanan: nomorPesanan,
        idempotency_key: idempotencyKey,
        nama_pembeli: customer_name,
        wa_pembeli: customer_phone,
        wa_pembeli_email: customer_email || null,
        alamat_lengkap: shipping_address,
        item_pesanan: itemsTervalidasi,
        total_harga: totalAmount,
        ongkir: ongkir,
        fee_bich: feeBich,
        metode_pembayaran: metodePembayaranLabel,
        // Simpan label yang enak dibaca (mis. "Kurir Instan BICH"), bukan
        // kode mentah (mis. "kurir_lokal") - supaya riwayat pesanan/admin
        // panel tidak menampilkan kode teknis ke pengguna.
        metode_pengiriman: opsiSah.label || shipping_method,
        status: "Pending",
      }])
      .select()
      .single();

    if (errInsert) {
      // Insert pesanan gagal setelah stok terlanjur direservasi - lepas lagi
      // stoknya supaya tidak nyangkut kepotong tanpa pesanan yang valid.
      await rilisStokAman(itemsUntukRilis, "insert pesanan gagal");

      // Unique violation di idempotency_key (race: dua request nyaris bersamaan
      // lolos cek "pesananLama" sebelum salah satu insert duluan) -> anggap
      // sebagai double-submit juga, bukan error sistem.
      if (String(errInsert.message || "").toLowerCase().includes("idempotency_key")) {
        return safeError("Pesanan dengan permintaan yang sama sedang diproses. Cek riwayat pesananmu.", 409, errInsert);
      }
      return safeError("Gagal menyimpan pesanan. Coba beberapa saat lagi.", 500, errInsert);
    }

    // ------------------------------------------------------------------
    // JALUR MANUAL (WhatsApp/transfer manual)
    // ------------------------------------------------------------------
    if (payment_method === "manual") {
      let textWA = `*PESANAN BICH MART*\n`;
      textWA += `No. Pesanan: ${nomorPesanan}\n`;
      textWA += `Nama: ${customer_name}\n`;
      textWA += `WA: ${customer_phone}\n`;
      textWA += `Alamat: ${shipping_address}\n`;
      textWA += `Pengiriman: ${opsiSah.label || shipping_method}\n\n`;
      textWA += `Total Tagihan: ${formatRupiah(totalAmount)}`;

      const whatsappUrl = `https://wa.me/${ADMIN_WA_NUMBER}?text=${encodeURIComponent(textWA)}`;

      return json({
        order_id: pesanan.id,
        nomor_pesanan: nomorPesanan,
        whatsapp_url: whatsappUrl,
        total_validated: totalAmount,
      });
    }

    // ------------------------------------------------------------------
    // JALUR PAYMENT GATEWAY (iPaymu)
    // ------------------------------------------------------------------
    const ipaymuBaseUrl = IPAYMU_ENV === "production"
      ? "https://my.ipaymu.com/api/v2/payment"
      : "https://sandbox.ipaymu.com/api/v2/payment";

    const baseReturnUrl = return_url || "https://mozensalqadrie.com/success.html?service=mart";
    const returnUrlFinal = baseReturnUrl.includes("order_id=")
      ? baseReturnUrl
      : `${baseReturnUrl}${baseReturnUrl.includes("?") ? "&" : "?"}order_id=${encodeURIComponent(nomorPesanan)}&status=pending`;

    const ipaymuPayload = {
      name: customer_name,
      phone: customer_phone,
      email: customer_email || "pembeli@bichmart.id",
      amount: totalAmount,
      notifyUrl: `${SUPABASE_URL}/functions/v1/ipaymu-webhook`,
      returnUrl: returnUrlFinal,
      cancelUrl: "https://mozensalqadrie.com/market/checkout.html",
      expired: 24,
      expiredType: "hours",
      comments: `Pesanan BICH Mart ${nomorPesanan}`,
      referenceId: String(pesanan.id),
      product: itemsTervalidasi.map((i) => i.nama_produk),
      qty: itemsTervalidasi.map((i) => i.qty),
      price: itemsTervalidasi.map((i) => i.harga),
    };

    let pgResponse: Response;
    let pgData: { Status?: number; Message?: string; Data?: { Url?: string; SessionID?: string; TransactionId?: string } };
    try {
      const signature = await generateIPaymuSignature(IPAYMU_VA, IPAYMU_API_KEY, ipaymuPayload);
      const timestamp = formatTimestampIPaymu(new Date());

      pgResponse = await fetch(ipaymuBaseUrl, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "va": IPAYMU_VA,
          "signature": signature,
          "timestamp": timestamp,
        },
        body: JSON.stringify(ipaymuPayload),
      });
      pgData = await pgResponse.json();
    } catch (ipaymuErr) {
      // Gagal total hubungin iPaymu (network error dsb) - pesanan Pending
      // yang sudah terlanjur dibuat jangan dibiarkan nyangkut, tandai Gagal
      // dan lepas stoknya.
      await supabaseAdmin.from("bich_pesanan").update({ status: "Gagal" }).eq("id", pesanan.id);
      await rilisStokAman(itemsUntukRilis, "iPaymu error jaringan");
      return safeError("Gagal menghubungi payment gateway. Coba beberapa saat lagi.", 502, ipaymuErr);
    }

    if (!pgResponse.ok || pgData.Status !== 200) {
      // iPaymu menolak transaksi - sama seperti di atas, jangan biarkan
      // pesanan nyangkut 'Pending' & stok tetap terpotong padahal tidak
      // ada transaksi pembayaran yang benar-benar dibuat.
      await supabaseAdmin.from("bich_pesanan").update({ status: "Gagal" }).eq("id", pesanan.id);
      await rilisStokAman(itemsUntukRilis, "iPaymu menolak transaksi");
      return safeError(pgData.Message || "Gagal membuat transaksi pembayaran.", 502, pgData);
    }

    const refGateway = String(pgData?.Data?.SessionID || pgData?.Data?.TransactionId || "");
    const { error: errUpdateRef } = await supabaseAdmin
      .from("bich_pesanan")
      .update({ payment_gateway_ref: refGateway })
      .eq("id", pesanan.id);

    if (errUpdateRef) {
      // Transaksi iPaymu SUDAH berhasil dibuat di sisi gateway - jangan
      // gagalkan response ke pembeli cuma karena update ref gagal. Cukup
      // log supaya bisa direkonsiliasi manual lewat redaksi/admin panel.
      console.error("[create-payment] Gagal simpan payment_gateway_ref untuk order", pesanan.id, errUpdateRef);
    }

    return json({ checkout_url: pgData.Data?.Url, order_id: pesanan.id, nomor_pesanan: nomorPesanan });

  } catch (err) {
    // Jaring pengaman terakhir: kalau stok sempat direservasi tapi ada
    // exception tak terduga sebelum sempat insert pesanan / handle di atas,
    // coba lepas stoknya juga - lebih baik overcompensate daripada stok
    // nyangkut kepotong tanpa pesanan sama sekali.
    if (stokSudahDireservasi && itemsUntukRilis.length > 0) {
      await rilisStokAman(itemsUntukRilis, "catch-all");
    }
    return safeError("Terjadi kesalahan sistem. Silakan coba lagi.", 500, err);
  }
});