// supabase/functions/ipaymu-webhook/index.ts
//
// CATATAN JUJUR: dokumentasi resmi iPaymu soal payload "Parameter Notify"
// yang saya temukan terpotong di bagian daftar field lengkapnya (cuma
// kebaca trx_id, reference_id, status...). Daripada menebak nama field
// dan skema verifikasi signature notify yang saya tidak yakin 100%,
// pendekatan di sini SENGAJA tidak percaya begitu saja isi body webhook.
// Begitu notify masuk, function ini balik nanya ke iPaymu sendiri
// ("Cek Transaksi" / checkTransaction) pakai kredensial kita, dan HANYA
// itu hasil yang dipercaya. Ini juga otomatis menutup risiko ada pihak
// lain yang kirim notify palsu ke endpoint ini.
//
// PENTING SEBELUM PAKAI DI PRODUKSI:
// 1. Uji di sandbox dulu, lihat log (`supabase functions logs ipaymu-webhook`)
//    buat lihat field apa saja yang beneran dikirim iPaymu.
// 2. Cek ulang path endpoint "Cek Transaksi" v2 (IPAYMU_CHECK_TX_PATH di
//    bawah) terhadap dashboard/dokumentasi iPaymu akun Anda — saya pakai
//    pola URL yang umum dipakai versi v1/v2, tapi belum saya verifikasi
//    100% ke dokumentasi resmi untuk v2.
//
// Deploy:
//   supabase functions deploy ipaymu-webhook --no-verify-jwt
//   (--no-verify-jwt WAJIB, karena iPaymu yang manggil endpoint ini,
//    bukan browser dengan sesi Supabase Auth)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IPAYMU_VA = Deno.env.get("IPAYMU_VA")!;
const IPAYMU_API_KEY = Deno.env.get("IPAYMU_API_KEY")!;
const IPAYMU_ENV = Deno.env.get("IPAYMU_ENV") || "sandbox";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const IPAYMU_CHECK_TX_URL =
  IPAYMU_ENV === "production"
    ? "https://my.ipaymu.com/api/v2/transaction"
    : "https://sandbox.ipaymu.com/api/v2/transaction";

Deno.serve(async (req) => {
  try {
    const rawBody = await req.text();
    console.log("[ipaymu-webhook] Body mentah diterima:", rawBody);

    // iPaymu bisa kirim application/x-www-form-urlencoded ATAU JSON
    // tergantung konfigurasi — tangani dua-duanya.
    let notifyData: Record<string, string> = {};
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      notifyData = JSON.parse(rawBody);
    } else {
      notifyData = Object.fromEntries(new URLSearchParams(rawBody));
    }

    const trxId = notifyData.trx_id || notifyData.trxId || notifyData.transactionId;
    const referenceId = notifyData.reference_id || notifyData.referenceId;

    if (!trxId) {
      console.error("[ipaymu-webhook] Tidak ada trx_id di body notify:", notifyData);
      return json({ error: "trx_id tidak ditemukan di notify" }, 400);
    }
    if (!referenceId) {
      console.error("[ipaymu-webhook] Tidak ada referenceId di body notify:", notifyData);
      return json({ error: "referenceId tidak ditemukan di notify" }, 400);
    }

    // ------------------------------------------------------------------
    // VERIFIKASI ULANG ke iPaymu — WAJIB berhasil. TIDAK ADA fallback ke
    // status dari body notify kalau verifikasi gagal.
    //
    // Kenapa ini tidak boleh dilonggarkan: endpoint webhook ini SELALU
    // deploy dengan --no-verify-jwt (memang harus, karena iPaymu yang
    // manggil, bukan user login), artinya URL ini bisa diakses SIAPA SAJA
    // di internet tanpa autentikasi. Kalau ada fallback "kalau cek API
    // gagal, percaya saja status dari body notify", siapa pun yang tahu
    // URL webhook ini bisa POST manual dengan status="success" +
    // reference_id sembarang, dan sistem akan auto-approve pesanan/
    // langganan/kurangi stok TANPA ada uang masuk sama sekali.
    //
    // Kalau verifikasi gagal -> JANGAN tandai sukses. Biarkan pending,
    // catat log selengkap mungkin untuk didiagnosis manual. "Fail closed".
    // ------------------------------------------------------------------
    const checkPayload = { transactionId: trxId };
    const signature = await generateIPaymuSignature(IPAYMU_VA, IPAYMU_API_KEY, checkPayload);
    const timestamp = formatTimestampIPaymu(new Date());

    const checkResp = await fetch(IPAYMU_CHECK_TX_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "va": IPAYMU_VA,
        "signature": signature,
        "timestamp": timestamp,
      },
      body: JSON.stringify(checkPayload),
    });

    // Baca sebagai teks dulu (bukan langsung .json()) supaya kalau iPaymu
    // balas HTML/kosong/error non-JSON, kita tetap dapat log yang jelas
    // alih-alih exception mentah yang kepotong ke error 500 generik.
    const checkRawText = await checkResp.text();
    console.log(
      "[ipaymu-webhook] Cek transaksi -> HTTP", checkResp.status,
      "| endpoint:", IPAYMU_CHECK_TX_URL,
      "| trxId:", trxId, "| referenceId:", referenceId,
      "| response mentah:", checkRawText
    );

    let checkData: Record<string, unknown> | null = null;
    try {
      checkData = JSON.parse(checkRawText) as Record<string, unknown>;
    } catch {
      console.error("[ipaymu-webhook] Response cek transaksi BUKAN JSON valid — lihat 'response mentah' di log atas.");
    }

    if (!checkResp.ok || !checkData?.Data) {
      console.error(
        "[ipaymu-webhook] GAGAL verifikasi ke iPaymu — transaksi TIDAK diproses (fail closed).",
        "Kemungkinan penyebab: (1) IPAYMU_VA/IPAYMU_API_KEY belum/salah di-set via `supabase secrets set`,",
        "(2) IPAYMU_ENV tidak cocok sandbox/production dengan kredensial yang dipakai,",
        "(3) endpoint", IPAYMU_CHECK_TX_URL, "bukan path yang benar - cek ulang ke dashboard/dukungan iPaymu."
      );
      return json({
        error: "Verifikasi ke iPaymu gagal, transaksi TIDAK diproses (fail closed demi keamanan).",
        detail: checkData ?? checkRawText,
      }, 502);
    }

    // Status resmi dari iPaymu (bukan dari body notify yang bisa dipalsukan)
    const dataObj = (checkData?.Data ?? {}) as Record<string, unknown>;

    // ‼️ PERBAIKAN: sebelumnya Status & StatusDesc digabung jadi satu string
    // lalu dicek substring "1" - itu 2 masalah sekaligus:
    //  (a) Status=7 (Escrow, dipakai iPaymu untuk VA/QRIS yang uangnya SUDAH
    //      masuk tapi ditahan escrow) tidak pernah cocok ke "berhasil" atau
    //      substring "1" ("7" tidak mengandung "1") - transaksi LUNAS malah
    //      ditandai Gagal. Ini yang bikin pesanan macet padahal sudah dibayar.
    //  (b) substring "1" itu sendiri rawan salah tangkap - status "10" atau
    //      "21" pun akan ke-match "1" padahal maknanya beda.
    // Sekarang Status dibandingkan sebagai ANGKA (bukan cocok-cocokan
    // substring), dan PaidStatus dicek terpisah sebagai sinyal tambahan.
    const statusNum = Number(dataObj.Status);
    const statusDesc = String(dataObj.StatusDesc ?? "").toLowerCase();
    const paidStatus = String(dataObj.PaidStatus ?? "").toLowerCase();

    // 1=Success, 6=Settlement, 7=Escrow (VA/QRIS - uang sudah diterima,
    // ditahan escrow sampai pesanan selesai - ini TETAP dihitung LUNAS dari
    // sisi kita, karena uangnya sudah benar-benar masuk).
    const STATUS_LUNAS = new Set([1, 6, 7]);
    const berhasilBayar =
      paidStatus === "paid" ||
      (Number.isFinite(statusNum) && STATUS_LUNAS.has(statusNum)) ||
      ["berhasil", "success", "completed"].some((s) => statusDesc.includes(s));

    // ------------------------------------------------------------------
    // VALIDASI SILANG referenceId — WAJIB, jangan dilewati.
    //
    // Verifikasi di atas cuma membuktikan "trx_id ini transaksi ASLI yang
    // berhasil di iPaymu" - itu TIDAK sama dengan "transaksi ini untuk
    // referenceId yang diklaim di notify". Tanpa cek ini, seseorang bisa
    // bayar pesanan Rp1.000 beneran (dapat trx_id ASLI berstatus sukses),
    // lalu kirim ulang notify manual ke endpoint ini dengan trx_id asli
    // itu tapi referenceId dioplos ke pesanan lain yang jauh lebih mahal -
    // lolos verifikasi karena trx_id-nya memang valid.
    //
    // iPaymu SEHARUSNYA mengembalikan referenceId yang didaftarkan saat
    // transaksi dibuat (dikirim sebagai "referenceId" di create-payment).
    // Nama field persis di response checkTransaction belum saya pastikan
    // 100% dari dokumentasi (lihat catatan di kepala file) - coba
    // beberapa variasi nama yang umum dipakai.
    // ------------------------------------------------------------------
    const refFromIpaymu = String(
      dataObj.ReferenceId ?? dataObj.referenceId ?? dataObj.reference_id ?? ""
    );

    if (!refFromIpaymu) {
      console.error(
        "[ipaymu-webhook] TIDAK ADA field referenceId di response checkTransaction iPaymu.",
        "Tidak bisa validasi silang - fail closed demi keamanan, transaksi TIDAK diproses.",
        "WAJIB dicek manual: buka log ini, lihat 'response mentah' di atas, cari field yang berisi",
        "referenceId asli, lalu update daftar nama field di refFromIpaymu.", "Data:", JSON.stringify(dataObj)
      );
      return json({
        error: "Tidak bisa validasi silang referenceId dari iPaymu - transaksi TIDAK diproses (fail closed). Cek log function untuk field yang benar.",
      }, 502);
    }

    if (refFromIpaymu !== referenceId) {
      console.error(
        "[ipaymu-webhook] referenceId TIDAK COCOK — kemungkinan notify palsu/dioplos.",
        "referenceId di notify:", referenceId, "| referenceId asli dari iPaymu:", refFromIpaymu,
        "| trxId:", trxId
      );
      return json({ error: "referenceId tidak cocok dengan data resmi iPaymu - transaksi TIDAK diproses (fail closed)." }, 400);
    }

    // ------------------------------------------------------------------
    // DISPATCH berdasarkan prefix referenceId — ditentukan saat pembuatan
    // transaksi di create-payment.ts (Mart, angka murni) vs
    // create-payment-layanan.ts (LK-/CV-/TR- -> transaksi_atm,
    // SUB- -> user_subscriptions).
    // ------------------------------------------------------------------
    let hasil: { table: string; statusBaru: string };

    if (referenceId.startsWith("SUB-")) {
      hasil = await prosesLangganan(referenceId, berhasilBayar, trxId);
    } else if (referenceId.startsWith("LK-") || referenceId.startsWith("CV-") || referenceId.startsWith("TR-")) {
      hasil = await prosesTransaksiAtm(referenceId, berhasilBayar, trxId);
    } else {
      hasil = await prosesPesananMart(referenceId, berhasilBayar, trxId);
    }

    return json({ status: "ok", table: hasil.table, status_baru: hasil.statusBaru });
  } catch (err) {
    console.error("[ipaymu-webhook] Error:", err);
    return json({ error: String(err) }, 500);
  }
});

async function prosesPesananMart(referenceId: string, berhasilBayar: boolean, trxId: string) {
  // ‼️ PERBAIKAN: referenceId di sini adalah id `bich_pesanan_grup`, BUKAN
  // `bich_pesanan` (anak) lagi - sejak create-payment.ts dipecah per toko,
  // referenceId yang dikirim ke iPaymu sudah mengarah ke grup (lihat header
  // file itu: "referenceId sekarang mengarah ke GRUP"). Versi lama fungsi
  // ini masih cari langsung di bich_pesanan pakai referenceId (jadi salah
  // tabel/salah id) dan menulis status "Success" yang tidak dikenali di
  // manapun (seller.html & trigger cegah_seller_ubah_kolom_terlarang cuma
  // paham Pending/Diproses/Dikirim/Selesai/Gagal) - itu BUG produksi yang
  // bikin pesanan macet permanen di "Pending" walau sudah dibayar.
  const { data: grup, error: errGrup } = await supabaseAdmin
    .from("bich_pesanan_grup")
    .select("id, status_pembayaran, payment_gateway_ref")
    .eq("id", referenceId)
    .single();

  if (errGrup || !grup) throw new Error("Pesanan (grup) tidak ditemukan: " + referenceId);

  // Idempotency - pola sama persis dengan prosesLangganan(): webhook bisa
  // terpanggil lebih dari sekali untuk trxId yang sama (retry dari gateway),
  // kalau trxId ini sudah pernah tercatat, jangan proses ulang (mencegah
  // cascade status ke anak jalan dobel).
  if (grup.payment_gateway_ref === trxId) {
    return { table: "bich_pesanan_grup", statusBaru: "already_processed" };
  }

  const statusPembayaranBaru = berhasilBayar ? "Success" : "Failed";
  await supabaseAdmin
    .from("bich_pesanan_grup")
    .update({ status_pembayaran: statusPembayaranBaru, payment_gateway_ref: trxId })
    .eq("id", grup.id);

  // Cascade ke SEMUA anak (satu per toko) sekaligus - HANYA yang masih
  // "Pending", supaya webhook yang terpanggil ulang tidak menimpa status
  // yang sudah dimajukan penjual (mis. sudah "Dikirim"/"Selesai"). Ini juga
  // titik yang tadinya TIDAK PERNAH tercapai karena bug di atas - jadi
  // status anak selalu nyangkut di "Pending" walau pembayaran sukses.
  const statusAnakBaru = berhasilBayar ? "Diproses" : "Gagal";
  const { error: errCascade } = await supabaseAdmin
    .from("bich_pesanan")
    .update({ status: statusAnakBaru })
    .eq("grup_id", grup.id)
    .eq("status", "Pending");

  if (errCascade) {
    console.error("[ipaymu-webhook] Gagal cascade status ke bich_pesanan anak untuk grup", grup.id, errCascade);
  }

  // CATATAN: stok TIDAK dipotong di sini - sudah direservasi atomic di
  // create-payment.ts saat pesanan dibuat (RPC reserve_stok_produk). Kalau
  // pembayaran gagal, stok dikembalikan lewat jalur release_stok_produk di
  // create-payment/expirasi pending - bukan tugas webhook ini.
  return { table: "bich_pesanan_grup", statusBaru: statusPembayaranBaru };
}

async function prosesTransaksiAtm(idTransaksi: string, berhasilBayar: boolean, trxId: string) {
  const { data: trx, error } = await supabaseAdmin
    .from("transaksi_atm")
    .select("id_transaksi, status_pembayaran, meta_data")
    .eq("id_transaksi", idTransaksi)
    .single();

  if (error || !trx) throw new Error("Transaksi tidak ditemukan: " + idTransaksi);
  if (trx.status_pembayaran === "SUCCESS") return { table: "transaksi_atm", statusBaru: "already_processed" };

  const statusBaru = berhasilBayar ? "SUCCESS" : "FAILED";
  await supabaseAdmin
    .from("transaksi_atm")
    .update({
      status_pembayaran: statusBaru,
      meta_data: { ...(trx.meta_data || {}), payment_gateway_ref: trxId },
    })
    .eq("id_transaksi", idTransaksi);

  // CATATAN: begitu status SUCCESS, ini titik yang tepat untuk memicu
  // aksi lanjutan (mis. auto-insert loker ke master_konten dengan
  // status_verifikasi='MENTAH' supaya masuk antrean redaksi, atau kirim
  // notifikasi WA admin). Belum diimplementasikan di sini - beri tahu
  // saya kalau mau langkah ini juga diotomatisasi.

  return { table: "transaksi_atm", statusBaru };
}

async function prosesLangganan(subId: string, berhasilBayar: boolean, trxId: string) {
  const { data: sub, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("sub_id, status, expires_at, payment_gateway_ref")
    .eq("sub_id", subId)
    .single();

  if (error || !sub) throw new Error("Langganan tidak ditemukan: " + subId);

  // Idempotency: kalau trxId ini sudah pernah tercatat sebagai pembayaran
  // yang diproses untuk langganan ini, jangan perpanjang lagi. Tanpa ini,
  // webhook yang terpanggil lebih dari sekali untuk pembayaran yang SAMA
  // (retry dari gateway saat respons pertama lambat/timeout) akan
  // memperpanjang expires_at berkali-kali dari satu kali bayar.
  if (sub.payment_gateway_ref === trxId) {
    return { table: "user_subscriptions", statusBaru: "already_processed" };
  }

  const statusBaru = berhasilBayar ? "active" : "pending";
  const update: Record<string, unknown> = { status: statusBaru, payment_gateway_ref: trxId };

  if (berhasilBayar) {
    // Perpanjang 30 hari dari expires_at lama (kalau masih berlaku) atau dari sekarang.
    const basis = sub.expires_at && new Date(sub.expires_at) > new Date() ? new Date(sub.expires_at) : new Date();
    basis.setDate(basis.getDate() + 30);
    update.expires_at = basis.toISOString();
    update.last_paid_at = new Date().toISOString();
  }

  await supabaseAdmin.from("user_subscriptions").update(update).eq("sub_id", subId);
  return { table: "user_subscriptions", statusBaru };
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

function formatTimestampIPaymu(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear().toString() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}