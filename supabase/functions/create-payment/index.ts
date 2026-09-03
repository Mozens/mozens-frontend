// supabase/functions/create-payment/index.ts
//
// VERSI SPLIT-PER-TOKO — dibangun di atas versi "Zero Trust Architecture" yang
// sudah ada. Perubahan inti dari versi sebelumnya:
//  1. Query produk sekarang ikut ambil `toko_id`.
//  2. Item dikelompokkan per toko_id, ongkir dihitung TERPISAH per kelompok
//     (bukan 1 ongkir gabungan untuk seluruh cart) - supaya akurat kalau 2
//     toko kebetulan 1 kota asal tapi tetap harus dikirim sebagai 2 paket.
//  3. Hasil akhir: 1 baris `bich_pesanan_grup` (level pembayaran) + N baris
//     `bich_pesanan` (satu per toko, status pengiriman independen).
//  4. Reservasi stok & idempotency tetap di level SELURUH cart (perilaku lama
//     dipertahankan) - hanya langkah PENULISAN pesanan yang dipecah.
//
// CATATAN JUJUR - BELUM SEPENUHNYA ATOMIC ANTAR TABEL:
// Supabase JS client di sini tidak memakai transaksi SQL multi-statement -
// pola yang dipakai (konsisten dengan file aslinya) adalah reservasi dulu,
// baru tulis, dan kalau tulis gagal di tengah jalan -> kompensasi manual
// (hapus baris yang sudah sempat masuk + lepas stok). Untuk keamanan penuh
// 100%, idealnya langkah "insert grup + insert semua anak" dibungkus 1 RPC
// Postgres (plpgsql, BEGIN/COMMIT implisit) - belum dibuat di sini, tandai
// sebagai TODO kalau mau dikeraskan lebih lanjut.
//
// CATATAN LAIN: kolom `toko_id` pada `bich_produk` DIASUMSIKAN sudah ada
// (dipakai di mart.html lewat join `bich_toko`). Kalau nama kolomnya beda
// (mis. `id_toko`), sesuaikan SATU baris di bagian "1. Ambil harga ASLI" di
// bawah.

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

const QTY_MIN = 1;
const QTY_MAX = 500;
const MAX_ITEMS_PER_CART = 50;
const NAME_MIN = 2, NAME_MAX = 100;
const ADDRESS_MIN = 5, ADDRESS_MAX = 500;
const EMAIL_MAX = 254;
const IDEMPOTENCY_WINDOW_MS = 60_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeError(clientMsg: string, status: number, internalErr?: unknown) {
  if (internalErr !== undefined) {
    console.error(`[create-payment] ${clientMsg} | detail:`, internalErr);
  }
  return json({ error: clientMsg }, status);
}

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

async function buatFingerprint(payload: object, timeBucket: number): Promise<string> {
  const encoder = new TextEncoder();
  const raw = JSON.stringify(payload) + ":" + timeBucket;
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(raw));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
    d.getFullYear().toString() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  );
}

// Kompensasi kalau penulisan grup/anak gagal di tengah jalan setelah stok
// terlanjur direservasi - hapus baris yang sudah sempat masuk + lepas stok.
async function batalkanPenulisanPesanan(grupId: number | null, childIds: number[], itemsUntukRilis: Array<{ id: string | number; qty: number }>, konteks: string) {
  if (childIds.length > 0) {
    await supabaseAdmin.from("bich_pesanan").delete().in("id", childIds);
  }
  if (grupId !== null) {
    await supabaseAdmin.from("bich_pesanan_grup").delete().eq("id", grupId);
  }
  await rilisStokAman(itemsUntukRilis, konteks);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

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
    // 0. Validasi input dasar (identik dengan versi sebelumnya)
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
    // 1. Ambil harga ASLI + toko_id dari Database
    //    (kalau kolomnya ternyata bernama lain di bich_produk, ganti
    //    "toko_id" di select() DAN di baris "asli.toko_id" di bawah)
    // ------------------------------------------------------------------
    const productIds = [...itemsQtyMap.keys()];
    const { data: produkAsli, error: errProduk } = await supabaseAdmin
      .from("bich_produk")
      .select("id, nama_produk, harga, stok, toko_id")
      .in("id", productIds);

    if (errProduk) {
      return safeError("Gagal verifikasi produk. Coba beberapa saat lagi.", 500, errProduk);
    }

    type ProdukRow = { id: string | number; nama_produk: string; harga: number; stok: number | null; toko_id: string | number };

    const produkMap = new Map<string, ProdukRow>(
      ((produkAsli || []) as ProdukRow[]).map((p) => [String(p.id), p])
    );

    type ItemValid = { id: string | number; nama_produk: string; harga: number; qty: number; toko_id: string | number };

    let subtotalKeseluruhan = 0;
    const itemsTervalidasi: ItemValid[] = [];

    for (const [idStr, qty] of itemsQtyMap) {
      const asli = produkMap.get(idStr);
      if (!asli) {
        return safeError(`Produk ID ${idStr} tidak ditemukan.`, 400);
      }
      if (asli.toko_id === undefined || asli.toko_id === null) {
        return safeError(`Produk "${asli.nama_produk}" belum terhubung ke lapak manapun - hubungi admin.`, 409);
      }
      subtotalKeseluruhan += asli.harga * qty;
      itemsTervalidasi.push({ id: asli.id, nama_produk: asli.nama_produk, harga: asli.harga, qty, toko_id: asli.toko_id });
    }

    // ------------------------------------------------------------------
    // 1b. Kelompokkan item per toko_id - ini yang tadinya tidak ada.
    // ------------------------------------------------------------------
    const kelompokPerToko = new Map<string, ItemValid[]>();
    for (const item of itemsTervalidasi) {
      const key = String(item.toko_id);
      if (!kelompokPerToko.has(key)) kelompokPerToko.set(key, []);
      kelompokPerToko.get(key)!.push(item);
    }

    // ------------------------------------------------------------------
    // 1c. Hitung ongkir TERPISAH untuk setiap kelompok toko.
    //     Kalau metode yang dipilih pembeli (shipping_method) tidak
    //     tersedia untuk salah satu toko, jangan gagal total - pakai opsi
    //     rekomendasi toko itu sebagai fallback, dan beri tahu di respons
    //     (checkout.html sebaiknya nanti diupgrade untuk pilih kurir per
    //     toko - untuk sekarang fallback ini menjaga transaksi tetap jalan).
    // ------------------------------------------------------------------
    type HasilOngkirToko = {
      tokoId: string;
      items: ItemValid[];
      subtotal: number;
      ongkir: number;
      labelKurir: string;
      feeBich: number;
      dipakaiFallback: boolean;
    };

    const hasilPerToko: HasilOngkirToko[] = [];

    for (const [tokoId, itemsToko] of kelompokPerToko) {
      let ongkirResp: Response;
      try {
        ongkirResp = await fetch(`${SUPABASE_URL}/functions/v1/hitung-ongkir`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
          body: JSON.stringify({
            kota_tujuan,
            items: itemsToko.map((i) => ({ produk_id: i.id, qty: i.qty })),
          }),
        });
      } catch (fetchErr) {
        return safeError("Layanan hitung ongkir sedang bermasalah. Coba beberapa saat lagi.", 502, fetchErr);
      }

      if (!ongkirResp.ok) {
        return safeError("Layanan hitung ongkir sedang bermasalah. Coba beberapa saat lagi.", 502, `HTTP ${ongkirResp.status}`);
      }

      const ongkirData = await ongkirResp.json();

      if (ongkirData?.error) {
        // MULTI_ORIGIN di dalam SATU toko berarti data lokasi produk toko itu
        // sendiri tidak konsisten - ini masalah data, teruskan pesannya apa adanya.
        return json({ error: ongkirData.message || ongkirData.error }, 400);
      }

      if (!ongkirData.opsi || ongkirData.opsi.length === 0) {
        return safeError("Tidak ada opsi pengiriman tersedia untuk salah satu toko di keranjangmu.", 400);
      }

      let opsiDipakai = ongkirData.opsi.find((o: { kode: string }) => o.kode === shipping_method);
      let dipakaiFallback = false;
      if (!opsiDipakai) {
        opsiDipakai = ongkirData.opsi.find((o: { rekomendasi: boolean }) => o.rekomendasi) || ongkirData.opsi[0];
        dipakaiFallback = true;
      }

      const subtotalToko = itemsToko.reduce((s, i) => s + i.harga * i.qty, 0);

      // TIER FEE PLATFORM (2.5% di bawah Rp 5jt omzet bulan berjalan, 5% di
      // atas itu) - lihat migration_tier_fee_dan_omzet_bulanan.sql. Dihitung
      // dari omzet TERKONFIRMASI (status Diproses/Dikirim/Selesai) toko ini
      // bulan ini, TIDAK termasuk pesanan yang baru mau dibuat sekarang
      // (belum dibayar, jadi belum "confirmed") - itu sebabnya query ini
      // harus jalan SEBELUM baris pesanan yang baru di-insert di bawah.
      // Kalau RPC ini gagal karena alasan apapun, fallback aman ke tier
      // terendah (2.5%) - JANGAN pernah gagalkan seluruh checkout hanya
      // karena gagal menentukan tier fee.
      let persenFeeToko = 0.025;
      try {
        const { data: omzetBulanIni, error: errOmzet } = await supabaseAdmin.rpc(
          "omzet_toko_bulan_ini",
          { p_toko_id: Number(tokoId) },
        );
        if (!errOmzet && typeof omzetBulanIni === "number" && omzetBulanIni >= 5_000_000) {
          persenFeeToko = 0.05;
        }
      } catch (_e) {
        // fallback ke 0.025 di atas, sengaja tidak melempar error ke buyer
      }
      const feeBichToko = Math.floor(subtotalToko * persenFeeToko);

      hasilPerToko.push({
        tokoId,
        items: itemsToko,
        subtotal: subtotalToko,
        ongkir: opsiDipakai.harga,
        labelKurir: opsiDipakai.label || shipping_method as string,
        feeBich: feeBichToko,
        dipakaiFallback,
      });
    }

    const totalAmount = hasilPerToko.reduce((s, h) => s + h.subtotal + h.ongkir + h.feeBich, 0);
    const feeBichTotal = hasilPerToko.reduce((s, h) => s + h.feeBich, 0);
    const nomorPesananInduk = `BM-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const metodePembayaranLabel = payment_method === "manual" ? "WhatsApp Manual" : "iPaymu QRIS/VA";

    // ------------------------------------------------------------------
    // 1d. Idempotency - identik konsepnya, sekarang dicek di level grup.
    // ------------------------------------------------------------------
    let idempotencyKey: string;
    if (isNonEmptyString(idempotencyKeyDariKlien, 8, 200)) {
      idempotencyKey = idempotencyKeyDariKlien as string;
    } else {
      const timeBucket = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
      idempotencyKey = await buatFingerprint(
        { customer_phone, kota_tujuan, shipping_method, items: [...itemsQtyMap.entries()].sort() },
        timeBucket
      );
    }

    const { data: grupLama } = await supabaseAdmin
      .from("bich_pesanan_grup")
      .select("id, nomor_pesanan, status_pembayaran, grand_total")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (grupLama) {
      return json({
        order_id: grupLama.id,
        nomor_pesanan: grupLama.nomor_pesanan,
        status: grupLama.status_pembayaran,
        total_validated: grupLama.grand_total,
        catatan: "Pesanan dengan permintaan yang sama sudah pernah dibuat sebelumnya.",
      });
    }

    // ------------------------------------------------------------------
    // 1e. Reservasi stok ATOMIC - tetap di level SELURUH cart (semua toko
    //     sekaligus), sama seperti versi sebelumnya.
    // ------------------------------------------------------------------
    itemsUntukRilis = itemsTervalidasi.map((i) => ({ id: i.id, qty: i.qty }));

    const { error: errReservasi } = await supabaseAdmin.rpc("reserve_stok_produk", {
      p_items: itemsUntukRilis,
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
    // 2a. Tulis baris GRUP (level pembayaran)
    // ------------------------------------------------------------------
    const { data: grup, error: errGrup } = await supabaseAdmin
      .from("bich_pesanan_grup")
      .insert([{
        nomor_pesanan: nomorPesananInduk,
        idempotency_key: idempotencyKey,
        nama_pembeli: customer_name,
        wa_pembeli: customer_phone,
        wa_pembeli_email: customer_email || null,
        alamat_lengkap: shipping_address,
        kota_tujuan: kota_tujuan,
        metode_pembayaran: metodePembayaranLabel,
        status_pembayaran: "Pending",
        grand_total: totalAmount,
        fee_bich: feeBichTotal,
      }])
      .select()
      .single();

    if (errGrup) {
      await rilisStokAman(itemsUntukRilis, "insert grup gagal");
      if (String(errGrup.message || "").toLowerCase().includes("idempotency_key")) {
        return safeError("Pesanan dengan permintaan yang sama sedang diproses. Cek riwayat pesananmu.", 409, errGrup);
      }
      return safeError("Gagal menyimpan pesanan. Coba beberapa saat lagi.", 500, errGrup);
    }

    // ------------------------------------------------------------------
    // 2b. Tulis baris ANAK - satu per toko
    // ------------------------------------------------------------------
    const childIdsSukses: number[] = [];
    for (const h of hasilPerToko) {
      const { data: anak, error: errAnak } = await supabaseAdmin
        .from("bich_pesanan")
        .insert([{
          grup_id: grup.id,
          toko_id: h.tokoId,
          nomor_pesanan: `${nomorPesananInduk}-T${h.tokoId}`,
          nama_pembeli: customer_name,
          wa_pembeli: customer_phone,
          wa_pembeli_email: customer_email || null,
          alamat_lengkap: shipping_address,
          item_pesanan: h.items,
          total_harga: h.subtotal + h.ongkir + h.feeBich,
          ongkir: h.ongkir,
          fee_bich: h.feeBich,
          metode_pembayaran: metodePembayaranLabel,
          metode_pengiriman: h.labelKurir,
          status: "Pending",
        }])
        .select("id")
        .single();

      if (errAnak) {
        await batalkanPenulisanPesanan(grup.id, childIdsSukses, itemsUntukRilis, "insert anak gagal");
        return safeError("Gagal menyimpan sebagian pesanan. Coba beberapa saat lagi.", 500, errAnak);
      }
      childIdsSukses.push(anak.id);
    }

    // ------------------------------------------------------------------
    // JALUR MANUAL (WhatsApp/transfer manual) - 1 pesan ke admin, dirinci per toko
    // ------------------------------------------------------------------
    if (payment_method === "manual") {
      let textWA = `*PESANAN BICH MART*\n`;
      textWA += `No. Pesanan: ${nomorPesananInduk}\n`;
      textWA += `Nama: ${customer_name}\n`;
      textWA += `WA: ${customer_phone}\n`;
      textWA += `Alamat: ${shipping_address}\n\n`;
      for (const h of hasilPerToko) {
        textWA += `— Toko ID ${h.tokoId} (${h.labelKurir}, ongkir ${formatRupiah(h.ongkir)}) —\n`;
        for (const it of h.items) textWA += `${it.qty}x ${it.nama_produk}\n`;
        textWA += `\n`;
      }
      textWA += `Total Tagihan: ${formatRupiah(totalAmount)}`;

      const whatsappUrl = `https://wa.me/${ADMIN_WA_NUMBER}?text=${encodeURIComponent(textWA)}`;

      return json({
        order_id: grup.id,
        nomor_pesanan: nomorPesananInduk,
        whatsapp_url: whatsappUrl,
        total_validated: totalAmount,
      });
    }

    // ------------------------------------------------------------------
    // JALUR PAYMENT GATEWAY (iPaymu) - referenceId sekarang mengarah ke GRUP
    // ------------------------------------------------------------------
    const ipaymuBaseUrl = IPAYMU_ENV === "production"
      ? "https://my.ipaymu.com/api/v2/payment"
      : "https://sandbox.ipaymu.com/api/v2/payment";

    const baseReturnUrl = return_url || "https://mozensalqadrie.com/success.html?service=mart";
    const returnUrlFinal = baseReturnUrl.includes("order_id=")
      ? baseReturnUrl
      : `${baseReturnUrl}${baseReturnUrl.includes("?") ? "&" : "?"}order_id=${encodeURIComponent(nomorPesananInduk)}&status=pending`;

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
      comments: `Pesanan BICH Mart ${nomorPesananInduk}`,
      referenceId: String(grup.id),
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
        headers: { "Accept": "application/json", "Content-Type": "application/json", "va": IPAYMU_VA, "signature": signature, "timestamp": timestamp },
        body: JSON.stringify(ipaymuPayload),
      });
      pgData = await pgResponse.json();
    } catch (ipaymuErr) {
      await supabaseAdmin.from("bich_pesanan_grup").update({ status_pembayaran: "Failed" }).eq("id", grup.id);
      await supabaseAdmin.from("bich_pesanan").update({ status: "Gagal" }).eq("grup_id", grup.id);
      await rilisStokAman(itemsUntukRilis, "iPaymu error jaringan");
      return safeError("Gagal menghubungi payment gateway. Coba beberapa saat lagi.", 502, ipaymuErr);
    }

    if (!pgResponse.ok || pgData.Status !== 200) {
      await supabaseAdmin.from("bich_pesanan_grup").update({ status_pembayaran: "Failed" }).eq("id", grup.id);
      await supabaseAdmin.from("bich_pesanan").update({ status: "Gagal" }).eq("grup_id", grup.id);
      await rilisStokAman(itemsUntukRilis, "iPaymu menolak transaksi");
      return safeError(pgData.Message || "Gagal membuat transaksi pembayaran.", 502, pgData);
    }

    const refGateway = String(pgData?.Data?.SessionID || pgData?.Data?.TransactionId || "");
    const { error: errUpdateRef } = await supabaseAdmin
      .from("bich_pesanan_grup")
      .update({ payment_gateway_ref: refGateway })
      .eq("id", grup.id);

    if (errUpdateRef) {
      console.error("[create-payment] Gagal simpan payment_gateway_ref untuk grup", grup.id, errUpdateRef);
    }

    return json({ checkout_url: pgData.Data?.Url, order_id: grup.id, nomor_pesanan: nomorPesananInduk });

  } catch (err) {
    if (stokSudahDireservasi && itemsUntukRilis.length > 0) {
      await rilisStokAman(itemsUntukRilis, "catch-all");
    }
    return safeError("Terjadi kesalahan sistem. Silakan coba lagi.", 500, err);
  }
});