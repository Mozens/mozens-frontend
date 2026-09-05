"""
BICH Redaksi Server — pengganti admin_bich2.py (Streamlit)
============================================================
Kenapa ini dipisah dari redaksi.html:
    SUPABASE_SERVICE_ROLE_KEY dan GOOGLE_API_KEY adalah kunci rahasia penuh.
    Kalau ditaruh langsung di file HTML/JS statis, siapa pun yang buka
    "View Page Source" bisa mencurinya. Server kecil ini pegang kunci-kunci
    itu, redaksi.html cuma bicara ke server ini lewat API biasa.

Cara pakai:
    pip install fastapi uvicorn python-dotenv supabase google-genai pydantic
    # .env sama persis seperti yang dipakai admin_bich2.py:
    #   SUPABASE_URL=...
    #   SUPABASE_SERVICE_ROLE_KEY=...
    #   GOOGLE_API_KEY=...
    #   ADMIN_PASSWORD=...
    python redaksi_server.py
    # lalu buka http://localhost:8787 di browser
"""

import os
import json
import secrets
import time
import random
from datetime import datetime, timedelta
from typing import Optional

from fastapi import FastAPI, HTTPException, Header, Depends, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from supabase import create_client, ClientOptions
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("MOZENS_SERVICE_ROLE_KEY")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")

if not all([SUPABASE_URL, SUPABASE_KEY, GOOGLE_API_KEY, ADMIN_PASSWORD]):
    raise RuntimeError(
        "Pastikan SUPABASE_URL, MOZENS_SERVICE_ROLE_KEY, GOOGLE_API_KEY, "
        "dan ADMIN_PASSWORD sudah diset."
    )

supabase = create_client(
    SUPABASE_URL, SUPABASE_KEY,
    options=ClientOptions(postgrest_client_timeout=30),
)

# ------------------------------------------------------------------
# ROTASI API KEY GEMINI
# ------------------------------------------------------------------
raw_keys = os.getenv("GOOGLE_API_KEY", "")
api_keys = [k.strip() for k in raw_keys.split(",") if k.strip()]

def get_gemini_client() -> genai.Client:
    """Mengambil 1 API key secara acak untuk setiap request ke Gemini"""
    if not api_keys:
        raise RuntimeError("GOOGLE_API_KEY tidak ditemukan di OS!")
    return genai.Client(api_key=random.choice(api_keys))

# Client default (tetap disediakan untuk kecocokan kode lama)
ai_client = get_gemini_client()

# ------------------------------------------------------------------
# APP & ROUTE UTAMA
# ------------------------------------------------------------------
app = FastAPI(title="BICH Redaksi Server")

@app.get("/")
@app.get("/redaksi.html")
async def serve_redaksi():
    """Melayani tampilan web redaksi.html di browser"""
    return FileResponse("redaksi.html")

# ------------------------------------------------------------------
# AUTH: token acak in-memory dengan masa berlaku (TTL), plus rate limit
# ------------------------------------------------------------------
TOKEN_TTL_SECONDS = 24 * 60 * 60  # token berlaku 24 jam sejak login
active_tokens: dict[str, float] = {}  # token -> waktu_expiry (epoch seconds)

# Rate limit percobaan login: maksimal 5 percobaan gagal per IP per 5 menit.
LOGIN_MAX_ATTEMPTS = 5
LOGIN_WINDOW_SECONDS = 5 * 60
login_attempts: dict[str, list[float]] = {}  # ip -> daftar timestamp percobaan gagal

def _bersihkan_token_kedaluwarsa():
    now = time.time()
    kedaluwarsa = [t for t, exp in active_tokens.items() if exp < now]
    for t in kedaluwarsa:
        active_tokens.pop(t, None)


def require_auth(authorization: Optional[str] = Header(None)) -> str:
    token = (authorization or "").replace("Bearer ", "").strip()
    _bersihkan_token_kedaluwarsa()
    expiry = active_tokens.get(token)
    if expiry is None:
        raise HTTPException(401, "Sesi tidak valid atau sudah habis, silakan login ulang.")
    if expiry < time.time():
        active_tokens.pop(token, None)
        raise HTTPException(401, "Sesi sudah kedaluwarsa (24 jam), silakan login ulang.")
    return token


class LoginBody(BaseModel):
    password: str


class GenerateBody(BaseModel):
    id: str
    force_regenerate: bool = False
    overrides: dict = {}


class PublishBody(BaseModel):
    id: str
    artikel: str
    caption_ig: str
    hook_tiktok: str
    lokasi: str = ""
    link_wa: str = ""
    link_foto: str = ""


class RejectBody(BaseModel):
    id: str


class HasilRedaksi(BaseModel):
    artikel: str
    caption_ig: str
    hook_tiktok: str


@app.post("/api/login")
def login(body: LoginBody, request: Request):
    ip = request.client.host if request.client else "unknown"
    now = time.time()

    # Buang percobaan gagal yang sudah di luar jendela waktu, lalu cek kuota.
    attempts = [t for t in login_attempts.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
    login_attempts[ip] = attempts
    if len(attempts) >= LOGIN_MAX_ATTEMPTS:
        sisa_detik = int(LOGIN_WINDOW_SECONDS - (now - attempts[0]))
        raise HTTPException(
            429,
            f"Terlalu banyak percobaan login gagal. Coba lagi dalam {max(sisa_detik, 1)} detik.",
        )

    # secrets.compare_digest: perbandingan constant-time, tidak bocorkan info
    # lewat selisih waktu respons (timing attack) seperti operator "!=" biasa.
    if not secrets.compare_digest(body.password, ADMIN_PASSWORD):
        login_attempts.setdefault(ip, []).append(now)
        raise HTTPException(401, "Password salah, Bolo.")

    # Login sukses -> reset penghitung percobaan gagal untuk IP ini.
    login_attempts.pop(ip, None)

    token = secrets.token_hex(24)
    active_tokens[token] = now + TOKEN_TTL_SECONDS
    return {"token": token, "expires_in": TOKEN_TTL_SECONDS}


@app.post("/api/logout")
def logout(authorization: Optional[str] = Header(None)):
    """DITAMBAHKAN: sebelumnya tombol 'Keluar' di redaksi.html cuma menghapus
    token di localStorage browser - token itu sendiri TETAP SAH di server
    sampai server di-restart. Sekarang logout beneran mencabut token di sini.
    """
    token = (authorization or "").replace("Bearer ", "").strip()
    active_tokens.pop(token, None)
    return {"status": "SUCCESS"}


def jalankan_pembersihan_loker_expired():
    """ENGINE ANTI-NYAMPAH Ringan (identik dengan versi Streamlit)."""
    try:
        batas_waktu = (datetime.now() - timedelta(days=20)).isoformat()
        supabase.table("master_konten").update({"status_verifikasi": "EXPIRED"}) \
            .eq("kategori", "Loker").eq("status_verifikasi", "MENTAH") \
            .lt("created_at", batas_waktu).execute()
        supabase.table("master_konten").update({"status_verifikasi": "EXPIRED"}) \
            .eq("kategori", "Loker").eq("status_verifikasi", "TERVERIFIKASI") \
            .lt("created_at", batas_waktu).execute()
    except Exception as e:
        print(f"[ANTI-NYAMPAH] Skip sweep: {e}")


@app.get("/api/queue")
def get_queue(_: str = Depends(require_auth)):
    jalankan_pembersihan_loker_expired()
    try:
        data = (
            supabase.table("master_konten")
            .select("*")
            .or_("status_verifikasi.eq.MENTAH,status.eq.Menunggu Redaksi")
            .order("created_at", desc=True)
            .limit(100)
            .execute()
        )
        return data.data
    except Exception as e:
        raise HTTPException(500, f"Gagal menarik data antrean (koneksi timeout?): {e}")


def fetch_item(item_id: str) -> dict:
    res = supabase.table("master_konten").select("*").eq("id", item_id).single().execute()
    if not res.data:
        raise HTTPException(404, "Item tidak ditemukan di database.")
    return res.data


def build_prompt_tokoh(item: dict) -> str:
    bahan_politik = f"""
    - Judul/Peristiwa: {item.get('judul','')}
    - Tokoh/Kebijakan: {item.get('jabatan_tokoh', '')} - {item.get('fokus_kebijakan', '')}
    - Info Tambahan: {item.get('info_tambahan', '')}
    """
    return f"""
    Kamu adalah Analis Politik & Kebijakan Publik Senior di BICH (Borneo Intelligence Hub).
    Tugasmu adalah membuat narasi ulasan politik berdasarkan data faktual berikut:

    [DATA MENTAH]
    {bahan_politik}

    ATURAN HUKUM & EDITORIAL (WAJIB DIPATUHI):
    1. ATRIBUSI SUMBER: Kamu WAJIB menyebutkan sumber berita di awal kalimat (misal: "Berdasarkan laporan dari ANTARA...", "Merujuk rilis resmi...", atau "Menurut pantauan data terbaru..."). Jangan buat seolah-olah ini liputan eksklusif BICH.
    2. FAKTA HARUS SAMA: Nama tokoh, jabatan, kebijakan, tanggal, dan data angka WAJIB 100% sama dengan data mentah. Jangan dikurangi, ditambah, atau dipelintir.
    3. JANGAN MENGARANG KALIMANTAN/IKN: Jangan pernah menghubungkan peristiwa politik ini ke wilayah Kalimantan atau IKN kecuali di dalam [DATA MENTAH] secara eksplisit tertulis kata tersebut. Jika tidak ada, fokuslah pada analisis dampak strategis secara nasional atau sektoral.
    4. NETRALITAS MUTLAK: Analisis wajib bersifat objektif dan netral secara jurnalisme. Dilarang keras memihak, memuji berlebihan, menjatuhkan tokoh/partai politik tertentu, atau memicu provokasi sosial.

    TUGAS OUTPUT: Buat JSON dengan 3 key wajib yang mematuhi aturan hukum di atas:
    1. artikel: Buat 2 paragraf narasi analisis politik yang berbobot. Paragraf 1 menerangkan dinamika peristiwa politik/kebijakan hari ini beserta konteksnya secara lugas. Paragraf 2 mengulas dampak strategisnya terhadap stabilitas sosial atau perekonomian secara objektif tanpa bumbu imajinasi.
    2. caption_ig: Rangkuman poin-poin penting dari analisis di atas yang padat, netral, & informatif bagi publik + 5 hashtag kebijakan/politik nasional yang relevan.
    3. hook_tiktok: 1 kalimat hook tajam tentang situasi kebijakan hari ini yang bikin penasaran.
    """


def build_prompt_ekonomi_teknikal(item: dict) -> str:
    sub_kategori = item.get('sub_kategori', 'Pasar Modal' if item.get('ihsg') else 'Makroekonomi')
    bahan_ekonomi = f"""
    - Judul/Peristiwa: {item.get('judul','')}
    - Jenis Analisis: {sub_kategori}
    - Posisi IHSG/Harga Acuan: {item.get('ihsg', 'Data Tidak Terlampir')}
    - Perubahan/Info: {item.get('perubahan_ihsg', '')} {item.get('info_tambahan', '')}

    [DATA TEKNIKAL & MARKET BICH]
    1. RSI (Relative Strength Index): {item.get('rsi', 'Netral / Tidak Ada Data')}
    2. MA20 (Moving Average 20 hari): {item.get('ma20', 'Tidak Ada Data')}
    3. Support: {item.get('support', 'Tidak Ada Data')}
    4. Resistance: {item.get('resistance', 'Tidak Ada Data')}
    5. Volume Bursa / Likuiditas: {item.get('volume', 'Rata-rata / Tidak Ada Data')}
    6. Sektor Terbaik: {item.get('sektor_terbaik', 'Tidak Ada Data')}
    7. Sektor Terburuk: {item.get('sektor_terburuk', 'Tidak Ada Data')}
    8. Saham Top Gainer: {item.get('saham_top_gainer', 'Tidak Ada Data')}
    9. Saham Top Loser: {item.get('saham_top_loser', 'Tidak Ada Data')}
    10. News Trigger: {item.get('news_trigger', 'Tidak Ada Data')}
    """
    return f"""
    Kamu adalah Kepala Arsitek Riset Ekonomi & Pasar Modal Regional di BICH.
    Tugasmu adalah menyusun intelijen finansial berbasis data mentah dan data teknikal berikut:

    [DATA MENTAH & METRIK]
    {bahan_ekonomi}

    LOGIKA PEMBELOKKAN ANALISIS (WAJIB DIPATUHI BERDASARKAN JENIS ANALISIS):

    A. JIKA 'Jenis Analisis' ADALAH PASAR MODAL:
       - Fokuslah pada analisis teknikal, psikologi market ritel, aksi korporasi, dan rotasi sektor.
       - Bedah hubungan antara pergerakan harga/IHSG dengan data teknikal di atas (misal: kondisi jenuh beli/jenuh jual dari RSI, posisi harga terhadap MA20/support/resistance, atau rotasi dana dari sektor terburuk ke sektor terbaik).

    B. JIKA 'Jenis Analisis' ADALAH MAKROEKONOMI:
       - Abaikan indikator teknikal ritel (RSI/MA20/support/resistance). Fokuslah pada indikator fundamental makro seperti kebijakan moneter, inflasi, nilai tukar rupiah, atau dampak komoditas global (CPO & Batubara) terhadap ekonomi nasional/regional.

    ATURAN HUKUM & EDITORIAL (ZERO-TOLERANCE HALLUCINATION):
    1. ATRIBUSI SUMBER: Wajib sebutkan sumber data di awal kalimat (misal: "Merujuk pada chart teknikal BICH...", "Menurut data perdagangan Bursa Efek Indonesia...").
    2. FAKTA HARUS SAMA: Angka, persentase, tren, dan status indikator WAJIB 100% akurat dengan data di atas. Jangan mengarang angka atau status indikator baru — KHUSUSNYA jangan mengarang indikator yang TIDAK disebutkan di data mentah (mis. MACD, Bollinger Bands, foreign flow) karena data itu memang tidak tersedia di sistem BICH.
    3. JANGAN MEMBERIKAN REKOMENDASI BELI/JUAL: Dilarang keras menulis kalimat ajakan investasi atau mengklaim kepastian pasar (No FOMO/Panic Selling encouragement).
    4. JANGAN MENGARANG KALIMANTAN: Jangan kaitkan ke Kalimantan/IKN kecuali ada data eksplisit di data mentah.

    TUGAS OUTPUT: Buat JSON dengan 3 key wajib:
    1. artikel: Buat 2 paragraf narasi ulasan yang tajam dan berbobot eksekutif.
       - Paragraf 1 menerangkan dinamika pergerakan data ekonomi/pasar modal hari ini secara mendalam berdasarkan 'Jenis Analisis'-nya.
       - Paragraf 2 mengulas proyeksi arah pergerakan ke depan (trend outlook) secara objektif dan rasional berdasarkan data yang ada.
    2. caption_ig: Rangkuman ringkas dalam bentuk poin-poin (bullet points) yang padat informasi untuk edukasi investor/pelaku usaha + 5 hashtag finansial yang relevan.
    3. hook_tiktok: 1 kalimat hook tajam yang menangkap esensi kondisi pasar atau makro ekonomi hari ini.
    """


def instant_template(item: dict) -> dict:
    kategori = item['kategori']
    if kategori == 'Loker':
        return {
            "artikel": f"LOWONGAN KERJA NEW: {item['judul']}\n\nPerusahaan {item.get('penyelenggara_perusahaan', '-')} saat ini sedang membuka kesempatan karir terbaru untuk posisi tersebut. Pastikan Anda memeriksa seluruh detail kualifikasi yang dibutuhkan sebelum mengirimkan lamaran terbaik Anda.",
            "caption_ig": f"💼 INFO LOKER TERBARU KALIMANTAN!\n\n📌 Posisi: {item['judul']}\n🏢 Perusahaan: {item.get('penyelenggara_perusahaan', '-')}\n\nKembangkan karirmu sekarang! Yuk bagikan info ini ke teman atau kerabat yang membutuhkan kerja. #LokerKalimantan #LowonganKerja #KerjaBorneo #LokerTerbaru #CariKerja",
            "hook_tiktok": f"Loker Baru di {item.get('penyelenggara_perusahaan', '-')}! Simak Kualifikasinya!",
        }
    if kategori == 'Pariwisata':
        return {
            "artikel": f"Eksplorasi Keindahan Destinasi Wisata: {item.get('nama_tempat', '-')}\n\nTerletak di wilayah administratif {item.get('provinsi', '-')}, objek wisata ini menyuguhkan pesona keindahan alam unik khas Pulau Borneo yang memanjakan mata. Sangat cocok dijadikan destinasi utama untuk melepas penat di akhir pekan.",
            "caption_ig": f"🌴 PESONA BORNEO INDONESIA!\n\n📍 Destinasi: {item.get('nama_tempat', '-')}\n📍 Lokasi: {item.get('provinsi', '-')}\n\nAgendakan liburan serumu ke sini bareng circle terbaikmu! #WisataKalimantan #PesonaBorneo #ExploreIndonesia #TravelBorneo #Pariwisata",
            "hook_tiktok": f"Hidden Gem Keren di {item.get('provinsi', '-')} Yang Wajib Lu Kunjungi!",
        }
    return {
        "artikel": f"Laporan Konten Faktual: {item['judul']}\n\nInformasi terbaru dirilis oleh {item.get('penyelenggara_perusahaan', 'Redaksi BICH')} mengenai {item['judul']}. Pantau terus perkembangan informasi valid ini langsung melalui portal Borneo Intelligence Hub.",
        "caption_ig": f"📰 KABAR BORNEO HARI INI!\n\nInformasi terkini mengenai: {item['judul']}\n\nSimak update lengkapnya hanya di BICH. Jangan lupa turn on notification biar tidak ketinggalan info penting seputar Kalimantan! #InfoTerbaru #KabarBorneo #KalimantanHariIni #BeritaValid",
        "hook_tiktok": "Ada info krusial nih warga Borneo, tonton sampai habis!",
    }


@app.post("/api/generate")
def generate(body: GenerateBody, _: str = Depends(require_auth)):
    item = fetch_item(body.id)
    item.update(body.overrides or {})
    kategori = item['kategori']

    # --- JALUR HEMAT TOKEN: konten Ekonomi/Politik/Berita dari pipeline Claude ---
    if kategori in ['Ekonomi', 'Politik', 'Berita'] and item.get('artikel_ai') and not body.force_regenerate:
        return {
            "artikel": item['artikel_ai'],
            "caption_ig": (item.get('info_tambahan') or '') + f"\n\n#BICH #Kalimantan #{kategori}",
            "hook_tiktok": (item.get('judul') or '')[:100],
            "source": "cached_zero_token",
        }

    # --- PROSES INSTAN (tanpa panggil AI sama sekali) ---
    if kategori not in ['Pasar Modal', 'Tokoh Politik']:
        res = instant_template(item)
        res["source"] = "instant_template"
        return res

    # --- BUTUH GEMINI (Pasar Modal / Tokoh Politik) ---
    prompt = build_prompt_tokoh(item) if kategori == 'Tokoh Politik' else build_prompt_ekonomi_teknikal(item)

    last_error = None
    for model_name in ["gemini-2.5-pro", "gemini-3.5-flash"]:
        try:
            response = ai_client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=HasilRedaksi,
                    temperature=0.7,
                ),
            )
            result = json.loads(response.text)
            result["source"] = f"gemini:{model_name}"
            return result
        except Exception as e:
            last_error = e
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e).upper():
                continue
            raise HTTPException(500, f"Gagal memanggil AI ({model_name}): {e}")

    raise HTTPException(503, f"Semua model AI sedang sibuk/limit, coba lagi sebentar. ({last_error})")


@app.post("/api/publish")
def publish(body: PublishBody, _: str = Depends(require_auth)):
    supabase.table("master_konten").update({
        "status_verifikasi": "TERVERIFIKASI",
        "status": "Ready",
        "artikel_ai": body.artikel,
        "caption_ig": body.caption_ig,
        "hook_tiktok": body.hook_tiktok,
        "lokasi": body.lokasi,
        "link_wa": body.link_wa,
        "link_foto": body.link_foto,
    }).eq("id", body.id).execute()
    return {"status": "SUCCESS"}


@app.post("/api/reject")
def reject(body: RejectBody, _: str = Depends(require_auth)):
    supabase.table("master_konten").update({
        "status_verifikasi": "DITOLAK",
        "status": "Ditolak",
    }).eq("id", body.id).execute()
    return {"status": "SUCCESS"}


class TarifRuteBody(BaseModel):
    route_key: str
    harga: int
    keterangan: str = ""


class TarifLayananBody(BaseModel):
    service_type: str
    tipe: str  # 'multiplier' | 'flat'
    nilai: float
    unit_label: str


class MitraBody(BaseModel):
    id: Optional[str] = None
    nama: str
    jenis_mitra: str = "individu"
    wa: str
    email: str = ""
    no_sim: str = ""
    kelas_sim: str = ""
    no_stnk: str = ""
    no_kir: str = ""
    kir_berlaku_sampai: Optional[str] = None
    asuransi_penumpang: bool = False
    nama_bank: str = ""
    no_rekening: str = ""
    nama_pemilik_rekening: str = ""
    komisi_platform_persen: float = 20
    status_verifikasi: str = "MENUNGGU"
    catatan_verifikasi: str = ""


class MitraKurirVerifikasiBody(BaseModel):
    id: str
    status_verifikasi: str  # TERVERIFIKASI atau DITOLAK - TIDAK bisa ganti data lain
    catatan_verifikasi: str = ""


# ------------------------------------------------------------------
# TARIF TRAVEL — admin edit di sini, langsung berlaku ke pariwisata.html
# (public read) dan create-payment-layanan (server-side authority).
# ------------------------------------------------------------------
@app.get("/api/tarif-rute")
def list_tarif_rute(_: str = Depends(require_auth)):
    res = supabase.table("tarif_travel_rute").select("*").order("route_key").execute()
    return res.data


@app.post("/api/tarif-rute")
def upsert_tarif_rute(body: TarifRuteBody, admin: str = Depends(require_auth)):
    supabase.table("tarif_travel_rute").upsert([{
        "route_key": body.route_key.upper(),
        "harga": body.harga,
        "keterangan": body.keterangan,
        "updated_at": datetime.now().isoformat(),
        "updated_by": "redaksi",
    }]).execute()
    return {"status": "SUCCESS"}


@app.delete("/api/tarif-rute/{route_key}")
def delete_tarif_rute(route_key: str, _: str = Depends(require_auth)):
    supabase.table("tarif_travel_rute").delete().eq("route_key", route_key.upper()).execute()
    return {"status": "SUCCESS"}


@app.get("/api/tarif-layanan")
def list_tarif_layanan(_: str = Depends(require_auth)):
    res = supabase.table("tarif_travel_layanan").select("*").order("service_type").execute()
    return res.data


@app.post("/api/tarif-layanan")
def upsert_tarif_layanan(body: TarifLayananBody, _: str = Depends(require_auth)):
    supabase.table("tarif_travel_layanan").upsert([{
        "service_type": body.service_type,
        "tipe": body.tipe,
        "nilai": body.nilai,
        "unit_label": body.unit_label,
        "updated_at": datetime.now().isoformat(),
        "updated_by": "redaksi",
    }]).execute()
    return {"status": "SUCCESS"}


# ------------------------------------------------------------------
# MITRA TRANSPORTASI — onboarding, verifikasi dokumen, dan antrean
# pencairan T+1 (lihat Pasal siklus pencairan di penjelasan bisnis).
# ------------------------------------------------------------------
@app.get("/api/mitra")
def list_mitra(_: str = Depends(require_auth)):
    res = supabase.table("mitra_transportasi").select("*").order("created_at", desc=True).execute()
    return res.data


@app.post("/api/mitra")
def upsert_mitra(body: MitraBody, _: str = Depends(require_auth)):
    payload = body.dict(exclude_none=True)
    if not payload.get("id"):
        payload.pop("id", None)
    supabase.table("mitra_transportasi").upsert([payload]).execute()
    return {"status": "SUCCESS"}


# ------------------------------------------------------------------
# MITRA KURIR — pendaftaran mandiri lewat market/driver.html (login WA,
# owner_id = auth.uid()). Panel ini CUMA boleh ubah status_verifikasi +
# catatan_verifikasi - TIDAK boleh timpa data profil/rekening mitra,
# itu wewenang mitra sendiri lewat RPC update_profil_mitra_kurir.
# ------------------------------------------------------------------
@app.get("/api/mitra-kurir")
def list_mitra_kurir(_: str = Depends(require_auth)):
    res = supabase.table("mitra_kurir").select("*").order("created_at", desc=True).execute()
    return res.data


@app.post("/api/mitra-kurir/verifikasi")
def verifikasi_mitra_kurir(body: MitraKurirVerifikasiBody, _: str = Depends(require_auth)):
    if body.status_verifikasi not in ("TERVERIFIKASI", "DITOLAK", "MENUNGGU"):
        raise HTTPException(400, "status_verifikasi tidak valid.")
    supabase.table("mitra_kurir").update({
        "status_verifikasi": body.status_verifikasi,
        "catatan_verifikasi": body.catatan_verifikasi,
    }).eq("id", body.id).execute()
    return {"status": "SUCCESS"}


# ------------------------------------------------------------------
# SIKLUS LAYANAN TRAVEL: assign mitra -> selesai -> (dispute opsional) -> payout
#
# Semua aturan bisnis (pembayaran harus SUCCESS sebelum assign, mitra harus
# TERVERIFIKASI, urutan status yang valid, dispute memblokir payout, dst)
# divalidasi ATOMIC di level RPC Postgres (lihat
# migration_payout_mitra_travel.sql), bukan di Python - supaya tidak ada
# race condition kalau dua admin klik aksi yang sama bersamaan, dan supaya
# aturannya tetap berlaku konsisten walau nanti dipanggil dari tempat lain
# selain redaksi_server.py.
# ------------------------------------------------------------------

def _pesan_dari_rpc_error(e: Exception) -> str:
    """Terjemahkan kode error dari RPC (Postgres 'raise exception KODE:detail')
    jadi pesan singkat berbahasa Indonesia buat ditampilkan di redaksi.html."""
    msg = str(e)
    mapping = {
        "TRANSAKSI_TIDAK_DITEMUKAN": "Transaksi tidak ditemukan.",
        "PEMBAYARAN_BELUM_SUKSES": "Pembayaran transaksi ini belum SUCCESS - tidak bisa assign mitra.",
        "MITRA_TIDAK_DITEMUKAN": "Mitra tidak ditemukan.",
        "MITRA_BELUM_TERVERIFIKASI": "Mitra ini belum berstatus TERVERIFIKASI.",
        "MITRA_BELUM_DITUGASKAN": "Belum ada mitra yang ditugaskan untuk transaksi ini.",
        "PAYOUT_SUDAH_DIBAYAR": "Payout untuk transaksi ini sudah DIBAYAR - dispute pasca-pembayaran butuh proses manual terpisah, bukan lewat endpoint ini.",
        "DISPUTE_SUDAH_DIAJUKAN": "Dispute untuk transaksi ini sudah pernah diajukan sebelumnya.",
        "TIDAK_ADA_DISPUTE_AKTIF": "Tidak ada dispute aktif untuk transaksi ini.",
        "HASIL_TIDAK_VALID": "Hasil harus 'LANJUT_BAYAR' atau 'BATALKAN_PAYOUT'.",
        "ADA_DISPUTE_AKTIF": "Ada dispute aktif untuk transaksi ini - selesaikan dispute dulu sebelum konfirmasi payout.",
        "STATUS_TIDAK_VALID": "Status transaksi tidak sesuai untuk aksi ini (urutan tahapannya belum sampai di sini).",
        "BUKTI_TRANSFER_WAJIB_DIISI": "Bukti transfer wajib diisi.",
        "PAYOUT_BELUM_DIBAYAR": "Transaksi ini belum berstatus DIBAYAR - kalau belum dibayar, pakai /api/transaksi/dispute (dispute biasa), bukan dispute pasca-bayar.",
        "CATATAN_WAJIB_DIISI": "Catatan dispute wajib diisi.",
    }
    for kode, pesan in mapping.items():
        if kode in msg:
            return pesan
    return f"Gagal memproses: {msg}"


class AssignMitraTransaksiBody(BaseModel):
    id_transaksi: str
    mitra_id: str  # uuid mitra_transportasi.id, dikirim sebagai string


class SelesaikanTransaksiBody(BaseModel):
    id_transaksi: str
    jam_dispute: int = 18  # default sesuai kebijakan saat ini - lihat catatan migrasi


class DisputeBody(BaseModel):
    id_transaksi: str
    alasan: str


class DisputeSelesaiBody(BaseModel):
    id_transaksi: str
    hasil: str  # 'LANJUT_BAYAR' atau 'BATALKAN_PAYOUT'


@app.get("/api/transaksi-menunggu-assign")
def get_transaksi_menunggu_assign(_: str = Depends(require_auth)):
    """Transaksi travel yang pembayarannya sudah SUCCESS dan sedang
    menunggu ditugaskan ke mitra."""
    res = (
        supabase.table("transaksi_atm")
        .select("id_transaksi, nama_pelanggan, nama_produk, total_harga, created_at")
        .eq("status_pembayaran", "SUCCESS")
        .eq("status_layanan", "MENUNGGU_ASSIGN")
        .order("created_at")
        .execute()
    )
    return res.data


@app.post("/api/transaksi/assign-mitra")
def assign_mitra_ke_transaksi(body: AssignMitraTransaksiBody, _: str = Depends(require_auth)):
    try:
        supabase.rpc("assign_mitra_transaksi", {
            "p_id_transaksi": body.id_transaksi,
            "p_mitra_id": body.mitra_id,
        }).execute()
    except Exception as e:
        raise HTTPException(409, _pesan_dari_rpc_error(e))
    return {"status": "SUCCESS"}


@app.post("/api/transaksi/selesai")
def tandai_transaksi_selesai(body: SelesaikanTransaksiBody, _: str = Depends(require_auth)):
    try:
        supabase.rpc("selesaikan_transaksi", {
            "p_id_transaksi": body.id_transaksi,
            "p_jam_dispute": body.jam_dispute,
        }).execute()
    except Exception as e:
        raise HTTPException(409, _pesan_dari_rpc_error(e))
    return {"status": "SUCCESS"}


@app.get("/api/transaksi-dispute-aktif")
def get_transaksi_dispute_aktif(_: str = Depends(require_auth)):
    """Transaksi yang sedang berstatus dispute, menunggu diselesaikan admin
    lewat /api/transaksi/dispute-selesai."""
    res = (
        supabase.table("transaksi_atm")
        .select("id_transaksi, nama_pelanggan, nama_produk, total_harga, mitra_id, "
                "dispute_alasan, selesai_at")
        .eq("ada_dispute", True)
        .order("selesai_at")
        .execute()
    )
    return res.data


@app.post("/api/transaksi/dispute")
def ajukan_dispute_transaksi(body: DisputeBody, _: str = Depends(require_auth)):
    try:
        supabase.rpc("ajukan_dispute_transaksi", {
            "p_id_transaksi": body.id_transaksi,
            "p_alasan": body.alasan,
        }).execute()
    except Exception as e:
        raise HTTPException(409, _pesan_dari_rpc_error(e))
    return {"status": "SUCCESS"}


@app.post("/api/transaksi/dispute-selesai")
def selesaikan_dispute_transaksi(body: DisputeSelesaiBody, _: str = Depends(require_auth)):
    if body.hasil not in ("LANJUT_BAYAR", "BATALKAN_PAYOUT"):
        raise HTTPException(400, "hasil harus 'LANJUT_BAYAR' atau 'BATALKAN_PAYOUT'.")
    try:
        supabase.rpc("selesaikan_dispute_transaksi", {
            "p_id_transaksi": body.id_transaksi,
            "p_hasil": body.hasil,
        }).execute()
    except Exception as e:
        raise HTTPException(409, _pesan_dari_rpc_error(e))
    return {"status": "SUCCESS"}


@app.post("/api/transaksi/hitung-dijadwalkan")
def hitung_dijadwalkan_manual(_: str = Depends(require_auth)):
    """Tombol manual 'hitung ulang sekarang' di redaksi.html - memanggil RPC
    yang sama dengan yang dijalankan otomatis oleh pg_cron tiap 6 jam.
    Berguna kalau pg_cron belum aktif di tier Supabase yang dipakai, atau
    admin mau lihat hasilnya langsung tanpa menunggu jadwal cron berikutnya."""
    try:
        res = supabase.rpc("hitung_dan_tandai_dijadwalkan", {}).execute()
    except Exception as e:
        raise HTTPException(500, f"Gagal menghitung antrean payout: {e}")
    return {"status": "SUCCESS", "diproses": res.data}


@app.get("/api/transaksi-berjalan")
def get_transaksi_berjalan(_: str = Depends(require_auth)):
    """Transaksi yang sudah ditugaskan ke mitra (DITUGASKAN), atau sudah
    SELESAI tapi masih dalam jendela dispute (payout_status masih BELUM,
    belum dipindah ke DIJADWALKAN). Dipakai admin untuk menandai selesai
    dan/atau mengajukan dispute sebelum transaksi masuk antrean pencairan."""
    res = (
        supabase.table("transaksi_atm")
        .select("id_transaksi, nama_pelanggan, nama_produk, total_harga, mitra_id, "
                "status_layanan, selesai_at, dispute_deadline, ada_dispute, payout_status")
        .in_("status_layanan", ["DITUGASKAN", "SELESAI"])
        .eq("payout_status", "BELUM")
        .order("assigned_at")
        .execute()
    )
    return res.data


@app.get("/api/payout-queue")
def get_payout_queue(_: str = Depends(require_auth)):
    """Daftar layanan yang sudah SELESAI, menunggu dicairkan ke mitra.
    dispute_deadline dipakai UI untuk warning kalau belum lewat 18 jam."""
    res = (
        supabase.table("transaksi_atm")
        .select("id_transaksi, nama_pelanggan, nama_produk, total_harga, mitra_id, "
                "status_layanan, selesai_at, dispute_deadline, ada_dispute, payout_status, "
                "payout_amount, fee_persen_dipakai")
        .eq("status_layanan", "SELESAI")
        .in_("payout_status", ["DIJADWALKAN"])
        .order("selesai_at")
        .execute()
    )
    return res.data


class PayoutKonfirmasiBody(BaseModel):
    id_transaksi: str
    bukti_transfer: str


@app.post("/api/payout-selesai")
def tandai_payout_selesai(body: PayoutKonfirmasiBody, _: str = Depends(require_auth)):
    """Dipanggil admin SETELAH transfer manual ke rekening mitra benar-benar
    dilakukan (bukan otomatis - lihat catatan Split Payment iPaymu di
    dokumentasi).

    DIPERBAIKI: versi sebelumnya menerima payout_amount langsung dari body
    request dan menuliskannya apa adanya ke database, tanpa validasi ulang
    terhadap nilai yang seharusnya. Sekarang payout_amount TIDAK diterima
    dari client sama sekali - dipakai nilai yang sudah dihitung server-side
    oleh hitung_dan_tandai_dijadwalkan() (fee per-mitra dari
    mitra_transportasi.komisi_platform_persen, dikunci di
    fee_persen_dipakai). Endpoint ini sekarang wajib mengisi bukti_transfer
    untuk jejak audit, dan memanggil RPC konfirmasi_payout_manual yang juga
    re-cek dispute aktif sebelum mengizinkan status DIBAYAR."""
    try:
        supabase.rpc("konfirmasi_payout_manual", {
            "p_id_transaksi": body.id_transaksi,
            "p_bukti": body.bukti_transfer,
        }).execute()
    except Exception as e:
        raise HTTPException(409, _pesan_dari_rpc_error(e))
    return {"status": "SUCCESS"}


class DisputePascaBayarBody(BaseModel):
    id_transaksi: str
    catatan: str


@app.post("/api/transaksi/dispute-pasca-bayar")
def catat_dispute_pasca_bayar(body: DisputePascaBayarBody, _: str = Depends(require_auth)):
    """Mencatat laporan dispute yang masuk SETELAH payout sudah DIBAYAR
    (uang sudah keluar ke mitra). TIDAK membatalkan atau menarik kembali
    dana yang sudah ditransfer - itu butuh proses di luar sistem (hubungi
    mitra langsung minta pengembalian). Endpoint ini cuma memastikan
    laporannya tercatat di database untuk ditindaklanjuti manual, tidak
    hilang begitu saja seperti sebelumnya."""
    try:
        supabase.rpc("catat_dispute_pasca_bayar", {
            "p_id_transaksi": body.id_transaksi,
            "p_catatan": body.catatan,
        }).execute()
    except Exception as e:
        raise HTTPException(409, _pesan_dari_rpc_error(e))
    return {"status": "SUCCESS"}



if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8787"))
    print(f"🚀 Meja Redaksi BICH jalan di http://localhost:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)