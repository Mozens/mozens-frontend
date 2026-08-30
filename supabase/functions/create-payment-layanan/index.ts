// supabase/functions/create-payment-layanan/index.ts
//
// Menggantikan alur Midtrans Snap (window.snap.pay) di monetisasi.html,
// pariwisata.html, dan langganan.html (jalur manual) dengan iPaymu redirect.
//
// PRINSIP SAMA seperti create-payment (Mart): harga TIDAK PERNAH dipercaya
// dari klien. Katalog harga di bawah ini adalah SATU-SATUNYA sumber
// kebenaran harga, harus sama persis dengan yang ditampilkan di UI
// (kalau nanti harga di UI diubah, WAJIB diubah juga di sini).
//
// Deploy:
//   supabase functions deploy create-payment-layanan

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IPAYMU_VA = Deno.env.get("IPAYMU_VA")!;
const IPAYMU_API_KEY = Deno.env.get("IPAYMU_API_KEY")!;
const IPAYMU_ENV = Deno.env.get("IPAYMU_ENV") || "sandbox";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const IPAYMU_PAY_URL =
  IPAYMU_ENV === "production" ? "https://my.ipaymu.com/api/v2/payment" : "https://sandbox.ipaymu.com/api/v2/payment";

// Batas wajar - cegah harga meledak/tidak masuk akal dari input pax yang absurd.
const PAX_MAX = 30;
const IDEMPOTENCY_WINDOW_MS = 60_000;

// Pesan error yang aman ditampilkan ke klien, detail asli cuma di-log server.
function safeError(clientMsg: string, status: number, internalErr?: unknown) {
  if (internalErr !== undefined) {
    console.error(`[create-payment-layanan] ${clientMsg} | detail:`, internalErr);
  }
  return json({ error: clientMsg }, status);
}

async function buatFingerprint(payload: object, timeBucket: number): Promise<string> {
  const encoder = new TextEncoder();
  const raw = JSON.stringify(payload) + ":" + timeBucket;
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(raw));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------
// KATALOG HARGA RESMI — HARUS SAMA dengan yang tampil di UI (kalau
// beda, itu bug, bukan fitur). Ini yang menentukan nominal ditagih,
// bukan apa pun yang dikirim dari browser.
// ------------------------------------------------------------------
const KATALOG: Record<string, { nama: string; harga: number }> = {
  LOKER_STANDARD: { nama: "Loker Premium - Standard (30 hari)", harga: 750_000 },
  LOKER_FEATURED: { nama: "Loker Premium - Featured (30 hari)", harga: 1_500_000 },
  LOKER_URGENT: { nama: "Loker Premium - Urgent Boost (14 hari)", harga: 2_500_000 },
  CV_SINGLE: { nama: "Assessment CV AI - Single Scan", harga: 49_000 },
  CV_BUNDLE: { nama: "Assessment CV AI - Scan + Konsultasi", harga: 149_000 },
  SAWIT_BASIC: { nama: "Alert Harga Sawit - Basic (1 bulan)", harga: 20_000 },
  SAWIT_PLUS: { nama: "Alert Harga Sawit - Plus (1 bulan)", harga: 35_000 },
  IKN_BASIC: { nama: "Briefing IKN Bisnis - Basic (1 bulan)", harga: 300_000 },
  IKN_PRIORITAS: { nama: "Briefing IKN Bisnis - Prioritas (1 bulan)", harga: 500_000 },
  RISK_BASIC: { nama: "Kahayan Political Risk Briefing - Basic (1 bulan)", harga: 750_000 },
  RISK_PRIORITAS: { nama: "Kahayan Political Risk Briefing - Prioritas (1 bulan)", harga: 1_500_000 },
};

// BARU - sebelumnya service:'tour' dari pariwisata.html (proceedToTourPayment)
// TIDAK PERNAH ditangani function ini sama sekali. tourId yang dikirim client
// dicocokkan ke sini per pax (harga per pax, dikalikan qty server-side -
// JANGAN percaya total dari client). Sesuaikan/pindah ke tabel
// pariwisata_charter kalau paket tour sudah dikelola dinamis dari database.
const TOUR_KATALOG: Record<string, { nama: string; hargaPerPax: number }> = {
  "tanjung-puting": { nama: "Tanjung Puting National Park Excursion", hargaPerPax: 4_800_000 },
  "loksado": { nama: "Loksado Bamboo Rafting & Cultural Tour", hargaPerPax: 1_950_000 },
};

// Tarif travel SEKARANG diambil dari tabel tarif_travel_rute &
// tarif_travel_layanan (admin-editable lewat redaksi.html), BUKAN
// hardcode di sini. Ini memastikan harga yang ditagihkan ke pembeli
// selalu mengikuti tarif terbaru yang di-set admin, tanpa perlu
// deploy ulang function ini tiap kali harga berubah.
async function hitungHargaTravel(origin: string, destination: string, serviceType: string): Promise<{ harga: number; unit: string }> {
  const { data: rows, error } = await supabaseAdmin
    .from("tarif_travel_rute")
    .select("route_key, harga")
    .in("route_key", [`${origin}_${destination}`, "AIRPORT", "DEFAULT"]);

  if (error) throw new Error("Gagal mengambil tarif rute (internal): " + error.message);

  const rateMap = new Map((rows ?? []).map((r) => [r.route_key, r.harga]));
  let harga: number;
  let unit = "/ kursi (Door-to-Door)";

  if (origin.includes("AIRPORT") || destination.includes("AIRPORT")) {
    harga = rateMap.get("AIRPORT") ?? 150_000;
    unit = "/ penjemputan airport";
  } else {
    harga = rateMap.get(`${origin}_${destination}`) ?? rateMap.get("DEFAULT") ?? 250_000;
  }

  const { data: layanan, error: errLayanan } = await supabaseAdmin
    .from("tarif_travel_layanan")
    .select("tipe, nilai, unit_label")
    .eq("service_type", serviceType)
    .maybeSingle();

  if (errLayanan) throw new Error("Gagal mengambil tarif layanan (internal): " + errLayanan.message);

  if (layanan) {
    unit = layanan.unit_label;
    const nilai = Number(layanan.nilai);
    if (!Number.isFinite(nilai)) {
      throw new Error(`Data tarif layanan "${serviceType}" tidak valid (nilai bukan angka) - cek redaksi/admin panel.`);
    }
    if (layanan.tipe === "flat") {
      harga = nilai;
    } else {
      harga = Math.round(harga * nilai);
    }
  }

  // Sanity check terakhir - jangan sampai harga 0/negatif/NaN lolos ke iPaymu
  // gara-gara data tarif salah input di admin panel.
  if (!Number.isFinite(harga) || harga <= 0) {
    throw new Error(`Hasil kalkulasi harga travel tidak valid (${harga}) - cek data tarif di redaksi/admin panel.`);
  }

  return { harga, unit };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { service, planCode, customer, origin, destination, serviceType, billingMode, manualSubId, tourId, pax, idempotency_key: idemDariKlien } = body;

    if (!service || !customer) {
      return safeError("Data tidak lengkap.", 400);
    }

    let nama_produk: string;
    let harga: number;

    if (service === "travel") {
      if (!origin || !destination || !serviceType) {
        return safeError("Rute/layanan travel tidak lengkap.", 400);
      }
      try {
        const hasil = await hitungHargaTravel(origin, destination, serviceType);
        harga = hasil.harga;
      } catch (e) {
        return safeError("Gagal menghitung tarif travel. Coba beberapa saat lagi.", 500, e);
      }
      nama_produk = `Travel/Shuttle: ${origin} -> ${destination} (${serviceType})`;
    } else if (service === "tour") {
      const paket = TOUR_KATALOG[tourId];
      if (!paket) return safeError(`Paket tour "${tourId}" tidak dikenal.`, 400);
      const jumlahPaxRaw = parseInt(pax, 10);
      if (!Number.isFinite(jumlahPaxRaw) || jumlahPaxRaw < 1 || jumlahPaxRaw > PAX_MAX) {
        return safeError(`Jumlah peserta tidak valid (maksimal ${PAX_MAX} pax per pemesanan).`, 400);
      }
      const jumlahPax = jumlahPaxRaw;
      harga = paket.hargaPerPax * jumlahPax;
      nama_produk = `Tour: ${paket.nama} (${jumlahPax} pax)`;
    } else {
      const item = KATALOG[planCode];
      if (!item) return safeError(`Kode paket "${planCode}" tidak dikenal.`, 400);
      harga = item.harga;
      nama_produk = item.nama;
    }

    // 'sawit' dan 'ikn' -> masuk tabel user_subscriptions (recurring, tapi
    // untuk sekarang billing_mode dipaksa 'manual' - lihat catatan di atas).
    const isLangganan = service === "sawit" || service === "ikn" || service === "risk";

    let refId: string;

    // Idempotency: dari klien kalau ada, atau fingerprint otomatis dari isi
    // request + jendela 60 detik - cegah double-klik checkout bikin baris
    // transaksi_atm/user_subscriptions ganda. Tidak berlaku untuk jalur
    // perpanjangan (manualSubId) karena itu UPDATE ke baris yang sudah ada,
    // bukan INSERT baru - double-submit di sana paling buruk cuma re-set
    // status jadi 'pending' dua kali, tidak bikin baris duplikat.
    let idempotencyKey: string;
    if (typeof idemDariKlien === "string" && idemDariKlien.length >= 8 && idemDariKlien.length <= 200) {
      idempotencyKey = idemDariKlien;
    } else {
      const timeBucket = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
      idempotencyKey = await buatFingerprint(
        { service, planCode, tourId, pax, origin, destination, serviceType, customerEmail: customer?.email, customerPhone: customer?.whatsapp },
        timeBucket
      );
    }

    if (isLangganan) {
      if (billingMode === "auto") {
        // Jalur kartu/auto-debit BELUM didukung integrasi iPaymu saat ini.
        return safeError("Langganan otomatis via kartu belum tersedia saat ini. Silakan pilih metode QRIS/Transfer manual.", 400);
      }

      const subId = manualSubId || `SUB-${service.toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      if (manualSubId) {
        // DIPERBAIKI: sebelumnya di sini cuma dicek apakah manualSubId itu
        // ADA, tidak dicek APAKAH ORANG YANG SUBMIT FORM INI BENERAN PEMILIK
        // langganan itu. Karena subId punya pola yang bisa ditebak
        // (SUB-{SERVICE}-{timestamp base36}), siapa pun yang menebak/tahu ID
        // ini bisa memicu "perpanjangan" atas nama orang lain dan mengganti
        // rujukan pembayarannya. Sekarang wajib email cocok dengan pemilik
        // asli sebelum perpanjangan diizinkan - sama seperti proteksi yang
        // sudah lebih dulu ada di server Express (Server_bich_payment.js).
        const { data: existing, error: errExisting } = await supabaseAdmin
          .from("user_subscriptions")
          .select("sub_id, customer_email")
          .eq("sub_id", manualSubId)
          .maybeSingle();

        if (errExisting) return safeError("Gagal memeriksa langganan. Coba beberapa saat lagi.", 500, errExisting);
        if (!existing) return safeError("Langganan yang mau diperpanjang tidak ditemukan.", 404);

        const emailCocok =
          typeof customer.email === "string" &&
          typeof existing.customer_email === "string" &&
          customer.email.trim().toLowerCase() === existing.customer_email.trim().toLowerCase();

        if (!emailCocok) {
          return safeError("Email tidak cocok dengan pemilik langganan ini.", 403);
        }

        await supabaseAdmin.from("user_subscriptions")
          .update({ status: "pending" }).eq("sub_id", manualSubId);
      } else {
        // Cek idempotency dulu sebelum insert baru.
        const { data: subLama } = await supabaseAdmin
          .from("user_subscriptions")
          .select("sub_id, status")
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();

        if (subLama) {
          return json({ order_id: subLama.sub_id, status: subLama.status, catatan: "Permintaan yang sama sudah pernah dibuat sebelumnya." });
        }

        const { error: errSub } = await supabaseAdmin.from("user_subscriptions").insert([{
          sub_id: subId,
          idempotency_key: idempotencyKey,
          service,
          plan_code: planCode,
          billing_mode: "manual",
          customer_name: customer.nama,
          customer_email: customer.email,
          customer_whatsapp: customer.whatsapp,
          status: "pending",
          expires_at: expiresAt.toISOString(),
        }]);
        if (errSub) {
          if (String(errSub.message || "").toLowerCase().includes("idempotency_key")) {
            return safeError("Permintaan yang sama sedang diproses. Cek status langgananmu.", 409, errSub);
          }
          return safeError("Gagal membuat langganan. Coba beberapa saat lagi.", 500, errSub);
        }
      }
      refId = subId;
    } else {
      // loker, cv, travel -> masuk tabel transaksi_atm (sekali bayar)
      const prefix = service === "loker" ? "LK" : service === "cv" ? "CV" : "TR";

      // Cek idempotency dulu sebelum insert baru.
      const { data: trxLama } = await supabaseAdmin
        .from("transaksi_atm")
        .select("id_transaksi, status_pembayaran")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();

      if (trxLama) {
        return json({ order_id: trxLama.id_transaksi, status: trxLama.status_pembayaran, catatan: "Permintaan yang sama sudah pernah dibuat sebelumnya." });
      }

      const idTransaksi = `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

      const namaPelanggan = customer.perusahaan || customer.nama || "-";
      const kontak = customer.whatsapp || customer.email || "-";

      const { error: errTx } = await supabaseAdmin.from("transaksi_atm").insert([{
        id_transaksi: idTransaksi,
        idempotency_key: idempotencyKey,
        nama_pelanggan: namaPelanggan,
        kontak_pelanggan: kontak,
        nama_produk,
        total_harga: harga,
        status_pembayaran: "PENDING",
        meta_data: { service, planCode, customer, origin, destination, serviceType },
      }]);

      if (errTx) {
        if (String(errTx.message || "").toLowerCase().includes("idempotency_key")) {
          return safeError("Permintaan yang sama sedang diproses. Cek status transaksimu.", 409, errTx);
        }
        return safeError("Gagal membuat transaksi. Coba beberapa saat lagi.", 500, errTx);
      }
      refId = idTransaksi;
    }

    // ------------------------------------------------------------------
    // Buat sesi bayar iPaymu
    // ------------------------------------------------------------------
    const namaPembeli = customer.perusahaan || customer.nama || "Pelanggan BICH";
    const emailPembeli = customer.email || "pelanggan@bichmart.id";
    const teleponPembeli = customer.whatsapp || "-";

    const ipaymuPayload = {
      name: namaPembeli,
      phone: teleponPembeli,
      email: emailPembeli,
      amount: harga,
      notifyUrl: `${SUPABASE_URL}/functions/v1/ipaymu-webhook`,
      returnUrl: `https://mozensalqadrie.com/success.html?order_id=${encodeURIComponent(refId)}&service=${encodeURIComponent(service)}&status=pending`,
      cancelUrl: `https://mozensalqadrie.com/bich/${
        service === "travel" || service === "tour" ? "pariwisata"
        : service === "risk" ? "langganan-risk"
        : isLangganan ? "langganan"
        : "monetisasi"
      }.html`,
      expired: 24,
      expiredType: "hours",
      comments: `${nama_produk} - Ref ${refId}`,
      referenceId: refId,
      product: [nama_produk],
      qty: [1],
      price: [harga],
    };

    const signature = await generateIPaymuSignature(IPAYMU_VA, IPAYMU_API_KEY, ipaymuPayload);
    const timestamp = formatTimestampIPaymu(new Date());

    const pgResponse = await fetch(IPAYMU_PAY_URL, {
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

    const pgData = await pgResponse.json();

    if (!pgResponse.ok || pgData.Status !== 200) {
      // Jangan biarkan row yang sudah terlanjur di-insert nyangkut PENDING/pending
      // selamanya kalau ternyata pembuatan sesi iPaymu gagal - sama seperti pola
      // di create-payment (Mart).
      if (isLangganan) {
        await supabaseAdmin.from("user_subscriptions").update({ status: "gagal" }).eq("sub_id", refId);
      } else {
        await supabaseAdmin.from("transaksi_atm").update({ status_pembayaran: "GAGAL" }).eq("id_transaksi", refId);
      }
      // pgData.Message berasal dari iPaymu sendiri (pesan gateway ke pengguna),
      // bukan detail internal kita - aman diteruskan apa adanya.
      return json({ error: pgData.Message || "Gagal membuat transaksi di iPaymu." }, 502);
    }

    // Simpan referensi sesi iPaymu
    const sessionRef = String(pgData.Data?.SessionID || pgData.Data?.TransactionId || "");
    if (isLangganan) {
      await supabaseAdmin.from("user_subscriptions").update({ payment_gateway_ref: sessionRef }).eq("sub_id", refId);
    } else {
      await supabaseAdmin.from("transaksi_atm")
        .update({ meta_data: { service, planCode, customer, origin, destination, serviceType, payment_gateway_ref: sessionRef } })
        .eq("id_transaksi", refId);
    }

    return json({ checkout_url: pgData.Data?.Url, order_id: refId });
  } catch (err) {
    return safeError("Terjadi kesalahan sistem. Silakan coba lagi.", 500, err);
  }
});

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

function formatTimestampIPaymu(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear().toString() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}