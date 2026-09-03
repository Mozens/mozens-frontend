// =============================================================================
// Edge Function: pilih-akun-jaas
// Dipanggil dari seller.html/live.html saat penjual klik "Mulai Live".
// Prinsip: 1 sesi live = 1 akun JaaS tetap dari awal sampai akhir. Rotasi
// terjadi PER SESI, bukan per penonton di tengah jalan.
//
// ‼️ BELUM DITEMPEL ke tombol "Mulai Live" manapun - gue belum punya file
// live.html atau bagian "Mulai Live" di seller.html untuk tahu nama
// fungsi/tombolnya. Ini function-nya sudah siap dipanggil, tinggal di-wire
// dari sisi frontend (lihat komentar CARA PAKAI di bawah).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
    }

    // Verifikasi identitas penjual dari JWT yang dikirim client (session
    // Supabase Auth seller.html), BUKAN dari body request - supaya seller A
    // tidak bisa iseng kirim toko_id milik seller B.
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Tidak ada token otorisasi." }), { status: 401 });
    }

    const supabaseAsUser = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: errUser } = await supabaseAsUser.auth.getUser(jwt);
    if (errUser || !userData?.user) {
      return new Response(JSON.stringify({ error: "Sesi login tidak valid, silakan login ulang." }), { status: 401 });
    }
    const ownerId = userData.user.id;

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Pastikan toko ini benar milik user yang sedang login.
    const { data: toko, error: errToko } = await supabaseAdmin
      .from("bich_toko")
      .select("id, owner_id, is_live, jaas_account_id")
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (errToko || !toko) {
      return new Response(JSON.stringify({ error: "Toko tidak ditemukan untuk akun ini." }), { status: 404 });
    }

    // RESUME: kalau sesi live toko ini SUDAH aktif dan sudah punya akun
    // terpasang (mis. seller reload halaman di tengah live), JANGAN
    // pilih akun baru - itu akan melanggar prinsip "1 sesi live = 1 akun
    // tetap dari awal sampai akhir" (room JaaS sudah dibuat dengan app_id
    // akun lama, ganti akun di tengah jalan akan memutus room itu).
    if (toko.is_live && toko.jaas_account_id) {
      const { data: akunLama, error: errAkunLama } = await supabaseAdmin
        .from("jaas_accounts")
        .select("id, app_id")
        .eq("id", toko.jaas_account_id)
        .maybeSingle();
      if (!errAkunLama && akunLama) {
        // Pastikan cache tetap konsisten (mis. kalau kolom ini baru
        // ditambahkan setelah beberapa toko sudah live) - idempotent.
        await supabaseAdmin.from("bich_toko").update({ jaas_app_id_cache: akunLama.app_id }).eq("id", toko.id);
        return new Response(
          JSON.stringify({ ok: true, toko_id: toko.id, jaas_account_id: akunLama.id, app_id: akunLama.app_id, resumed: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Kalau akun lama somehow sudah tidak ada/dinonaktifkan, lanjut ke
      // alur pilih baru di bawah sebagai fallback.
    }

    // SESI BARU: pilih akun JaaS paling longgar via fungsi SQL (lihat
    // migration_jaas_rolling.sql).
    const { data: akunTerpilih, error: errPilih } = await supabaseAdmin.rpc("pilih_akun_jaas");
    if (errPilih) {
      console.error("Gagal query pilih_akun_jaas:", errPilih.message);
      return new Response(JSON.stringify({ error: "Gagal memilih akun JaaS." }), { status: 500 });
    }

    if (!akunTerpilih || akunTerpilih.length === 0) {
      // Semua akun sudah dekat limit. TODO: kirim notifikasi ke admin lewat
      // kanal terpisah (mis. tabel alert internal atau webhook Slack/WA
      // admin) - belum diimplementasikan di sini karena belum ada kanal
      // notifikasi admin yang disepakati.
      return new Response(
        JSON.stringify({ error: "Kapasitas live sedang penuh, coba beberapa menit lagi atau hubungi admin." }),
        { status: 503 },
      );
    }

    const akun = akunTerpilih[0];

    // Simpan akun terpilih ke baris toko + tandai live aktif. jaas_app_id_cache
    // dicatat di sini juga supaya penonton bisa baca app_id lewat select
    // bich_toko biasa (lihat catatan di migration_jaas_rolling.sql).
    const { error: errUpdate } = await supabaseAdmin
      .from("bich_toko")
      .update({ jaas_account_id: akun.id, jaas_app_id_cache: akun.app_id, is_live: true })
      .eq("id", toko.id);
    if (errUpdate) {
      return new Response(JSON.stringify({ error: "Gagal mengaktifkan sesi live." }), { status: 500 });
    }

    // Hanya app_id yang dikirim ke client - app_secret TIDAK PERNAH keluar
    // dari server. Pembuatan JWT room JaaS tetap 100% di server, sama pola
    // dengan melawi-jitsi-token yang sudah terbukti jalan.
    return new Response(
      JSON.stringify({ ok: true, toko_id: toko.id, jaas_account_id: akun.id, app_id: akun.app_id, resumed: false }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("pilih-akun-jaas error:", err);
    return new Response(JSON.stringify({ error: "Terjadi kesalahan server." }), { status: 500 });
  }
});

// =============================================================================
// CARA PAKAI (belum di-wire, dokumentasi untuk saat mengerjakan live.html):
//   1. Saat seller klik "Mulai Live": panggil Edge Function ini dulu ->
//      dapat { app_id, jaas_account_id } -> baru generate JWT room (fungsi
//      terpisah, mirip melawi-jitsi-token tapi pakai app_secret sesuai
//      app_secret_ref dari akun terpilih) -> baru setupJitsi().
//   2. Saat penonton join (live.html, tombol "Gabung Live Sekarang"):
//      sebelum setupJitsi(), upsert ke jaas_usage_log:
//        insert into jaas_usage_log (account_id, visitor_uid, bulan, toko_id)
//        values ($1, $2, to_char(now(),'YYYY-MM'), $3)
//        on conflict do nothing;
//      account_id diambil dari bich_toko.jaas_account_id milik toko yang
//      sedang ditonton (bukan dipilih ulang - sesi yang sama harus tetap di
//      akun yang sama sampai live berakhir).
//   3. Saat seller klik "Akhiri Live": set is_live=false. jaas_account_id
//      boleh dibiarkan (untuk riwayat) atau di-null-kan, tergantung apakah
//      butuh audit trail akun mana yang dipakai sesi sebelumnya.
// =============================================================================