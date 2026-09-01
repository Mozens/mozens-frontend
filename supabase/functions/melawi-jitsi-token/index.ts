// supabase/functions/melawi-jitsi-token/index.ts
//
// Menerbitkan JWT JaaS (8x8) buat peserta yang mau masuk kelas live Melawi.
// Menggantikan meet.jit.si publik yang TIDAK BOLEH dipakai production
// (dokumentasi resmi Jitsi: "meet.jit.si is not meant for use in production
// applications" - integrasi embed via API di sana bahkan bisa auto-disconnect
// di menit ke-5 buat penggunaan non-testing).
//
// Alur:
//   1. Verifikasi caller adalah user Supabase Auth yang sah (dari header
//      Authorization: Bearer <access_token> sesi mereka sendiri).
//   2. Cek user itu BENERAN terdaftar di Cohort 01 (ada baris session_code
//      = 'DAFTAR' di melawi_attendance) - re-verifikasi server-side, tidak
//      percaya status "terdaftar" dari state JS frontend yang bisa basi/
//      dipalsukan.
//   3. Kalau lolos, tandatangani JWT RS256 yang di-lock CUMA buat 1 room
//      (bukan wildcard "*") dan berlaku beberapa jam.
//
// Env vars (Supabase secrets) yang wajib di-set sebelum deploy:
//   JAAS_APP_ID      -> AppID JaaS, mis. vpaas-magic-cookie-xxxxxxxx
//   JAAS_KID         -> Key ID JaaS, mis. vpaas-magic-cookie-xxxxxxxx/xxxxxx
//   JAAS_PRIVATE_KEY -> isi file .pem Private Key yang di-download sekali
//                       waktu generate API key di jaas.8x8.vc (8x8 TIDAK
//                       menyimpan private key-nya - kalau hilang harus
//                       generate ulang). Simpan dengan newline asli kalau
//                       lewat Supabase Dashboard, atau escape \n kalau lewat
//                       CLI (`supabase secrets set`) - kode di bawah sudah
//                       menangani dua-duanya.
//   JITSI_ROOM_NAME  -> harus PERSIS SAMA dengan JITSI_ROOM_NAME di
//                       melawi.html, mis. BICH_RuangMelawi_Cohort01_SesuaiNamaUnik99
//
// Deploy:
//   supabase functions deploy melawi-jitsi-token

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as jose from "https://esm.sh/jose@5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const JAAS_APP_ID = Deno.env.get("JAAS_APP_ID")!;
const JAAS_KID = Deno.env.get("JAAS_KID")!;
const JAAS_PRIVATE_KEY_RAW = Deno.env.get("JAAS_PRIVATE_KEY")!;
const JITSI_ROOM_NAME = Deno.env.get("JITSI_ROOM_NAME")!;

const TOKEN_BERLAKU_DETIK = 4 * 60 * 60; // 4 jam - cukup buat 1 sesi kelas + buffer

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function safeError(clientMsg: string, status: number, internalErr?: unknown) {
  if (internalErr !== undefined) {
    console.error(`[melawi-jitsi-token] ${clientMsg} | detail:`, internalErr);
  }
  return json({ error: clientMsg }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // ------------------------------------------------------------------
    // 1. Verifikasi caller lewat sesi Supabase Auth mereka sendiri - BUKAN
    //    service role, supaya kita tau persis siapa yang sebenarnya minta
    //    token ini (bukan cuma percaya user_id yang dikirim di body).
    // ------------------------------------------------------------------
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) {
      return safeError("Belum login.", 401);
    }

    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !userData?.user) {
      return safeError("Sesi login tidak valid, silakan login ulang.", 401, authErr);
    }
    const user = userData.user;

    // ------------------------------------------------------------------
    // 2. Re-verifikasi status pendaftaran Cohort 01 server-side. Tidak
    //    percaya flag "terdaftar" dari frontend - status itu bisa basi
    //    (mis. tab dibuka lama) atau, secara teori, dimanipulasi di
    //    devtools sebelum request ini dikirim.
    // ------------------------------------------------------------------
    const { data: daftarRow, error: errCekDaftar } = await supabaseAdmin
      .from("melawi_attendance")
      .select("user_id")
      .eq("user_id", user.id)
      .eq("session_code", "DAFTAR")
      .maybeSingle();

    if (errCekDaftar) {
      return safeError("Gagal memeriksa status pendaftaran. Coba beberapa saat lagi.", 500, errCekDaftar);
    }
    if (!daftarRow) {
      return safeError("Kamu belum terdaftar di Cohort 01 (kuota mungkin sudah penuh saat kamu login).", 403);
    }

    // ------------------------------------------------------------------
    // 3. Tandatangani JWT JaaS - di-lock ke SATU room spesifik (bukan "*"),
    //    supaya token ini tidak bisa dipakai untuk masuk room JaaS lain di
    //    AppID yang sama kalau suatu saat ada room lain (mis. Mart Live).
    // ------------------------------------------------------------------
    const privateKeyPem = JAAS_PRIVATE_KEY_RAW.includes("\\n")
      ? JAAS_PRIVATE_KEY_RAW.replace(/\\n/g, "\n")
      : JAAS_PRIVATE_KEY_RAW;

    let privateKey: CryptoKey;
    try {
      privateKey = await jose.importPKCS8(privateKeyPem, "RS256");
    } catch (keyErr) {
      return safeError("Konfigurasi server bermasalah (private key tidak valid).", 500, keyErr);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const namaTampil = (user.user_metadata as Record<string, unknown> | null)?.full_name as string | undefined;

    const jwt = await new jose.SignJWT({
      room: JITSI_ROOM_NAME,
      context: {
        user: {
          id: user.id,
          name: namaTampil || user.email || "Peserta Melawi",
          email: user.email || "",
          avatar: "",
          moderator: false,
        },
        features: {
          livestreaming: false,
          recording: false,
          "outbound-call": false,
          transcription: false,
        },
      },
    })
      .setProtectedHeader({ alg: "RS256", kid: JAAS_KID, typ: "JWT" })
      .setIssuer("chat")
      .setAudience("jitsi")
      .setSubject(JAAS_APP_ID)
      .setNotBefore(nowSec - 10)
      .setExpirationTime(nowSec + TOKEN_BERLAKU_DETIK)
      .sign(privateKey);

    return json({ jwt, app_id: JAAS_APP_ID, room: JITSI_ROOM_NAME, expires_in: TOKEN_BERLAKU_DETIK });
  } catch (err) {
    return safeError("Terjadi kesalahan sistem.", 500, err);
  }
});