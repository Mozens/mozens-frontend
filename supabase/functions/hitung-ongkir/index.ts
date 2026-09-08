import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const KODE_POS: Record<string, number> = {
  'Banjarmasin': 70111, 'Banjarbaru': 70711, 'Martapura': 70614,
  'Palangka Raya': 73111, 'Samarinda': 75111, 'Balikpapan': 76111,
  'Pontianak': 78111, 'Tarakan': 77111,
}

// Kurir mitra internal ("Kurir Instan BICH") boleh menjangkau kota-kota
// TERDEKAT yang berdekatan (bukan cuma 1 kota persis) - dikelompokkan
// berdasar kedekatan wilayah nyata. Kalau kota tujuan ada di klaster yang
// sama dengan kota asal produk, kurir mitra tetap dicoba dulu sebelum
// jatuh ke Biteship.
const KLASTER_KOTA_TERDEKAT: Record<string, string[]> = {
  'Banjarmasin': ['Banjarmasin', 'Banjarbaru', 'Martapura'],
  'Banjarbaru': ['Banjarmasin', 'Banjarbaru', 'Martapura'],
  'Martapura': ['Banjarmasin', 'Banjarbaru', 'Martapura'],
  'Samarinda': ['Samarinda', 'Balikpapan'],
  'Balikpapan': ['Samarinda', 'Balikpapan'],
  'Palangka Raya': ['Palangka Raya'],
  'Pontianak': ['Pontianak'],
  'Tarakan': ['Tarakan'],
}

function kotaTerjangkauKurirMitra(originKota: string, kotaTujuan: string): boolean {
  const klaster = KLASTER_KOTA_TERDEKAT[originKota] || [originKota]
  return klaster.includes(kotaTujuan)
}

// Batas wajar kuantitas per item - cegah qty negatif/nol/gila-gilaan
// yang bisa manipulasi totalBeratGram jadi lebih kecil dari seharusnya.
const QTY_MIN = 1
const QTY_MAX = 500
const BERAT_DEFAULT_GRAM = 1000 // konservatif ke atas kalau berat_gram kosong, bukan ke bawah

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { kota_tujuan, items } = await req.json()
    if (!kota_tujuan || !items?.length) {
      throw new Error('kota_tujuan dan items wajib diisi.')
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('MOZENS_SERVICE_ROLE_KEY')!
    )

    // --- Validasi & normalisasi qty per item ---
    // Number(-5) atau Number("abc") -> NaN masih bisa lolos truthy check lama,
    // jadi qty divalidasi eksplisit: harus integer positif dalam batas wajar.
    const qtyMap = new Map<number, number>()
    for (const i of items as Array<{ produk_id: number; qty?: number; kuantitas?: number }>) {
      const rawQty = i.qty ?? i.kuantitas ?? 1
      const qty = Number(rawQty)

      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < QTY_MIN || qty > QTY_MAX) {
        throw new Error(`Kuantitas tidak valid untuk produk_id ${i.produk_id}.`)
      }
      if (!Number.isFinite(Number(i.produk_id))) {
        throw new Error('produk_id tidak valid.')
      }
      qtyMap.set(i.produk_id, qty)
    }

    const produkIds = [...qtyMap.keys()]
    const { data: produkList, error: errProduk } = await supabase
      .from('bich_produk')
      .select('id, lokasi, berat_gram')
      .in('id', produkIds)

    if (errProduk) {
      // Jangan bocorin detail error Supabase (struktur tabel/kolom) ke klien.
      console.error('Supabase error saat query bich_produk:', errProduk)
      throw new Error('Gagal memuat data produk.')
    }

    // Cross-check: semua produk_id yang dikirim klien harus ketemu di DB.
    // Kalau ada yang hilang (dihapus/tidak ada), tolak - jangan diam-diam
    // dianggap berat 0 karena itu bikin ongkir underestimate.
    const produkIdsUnique = new Set(produkIds)
    if (!produkList || produkList.length !== produkIdsUnique.size) {
      const ditemukan = new Set((produkList || []).map(p => p.id))
      const hilang = [...produkIdsUnique].filter(id => !ditemukan.has(id))
      throw new Error(`Produk tidak ditemukan atau sudah tidak tersedia: ${hilang.join(', ')}`)
    }

    const totalBeratGram = produkList.reduce((sum, p) => {
      const qty = qtyMap.get(p.id) || 1
      const beratSatuan = p.berat_gram || BERAT_DEFAULT_GRAM
      return sum + (beratSatuan * qty)
    }, 0)

    const lokasiAsalSet = new Set(produkList.map(p => p.lokasi).filter(Boolean))

    // Kalau tidak ada satupun produk yang punya lokasi asal terisi,
    // JANGAN nebak/fallback ke kota manapun - data lokasi asal itu wajib
    // ada supaya ongkir akurat. Lebih baik gagal eksplisit daripada
    // ngasih ongkir yang keliru berdasarkan asumsi.
    if (lokasiAsalSet.size === 0) {
      return new Response(JSON.stringify({
        opsi: [],
        error: 'ORIGIN_TIDAK_DIKETAHUI',
        message: 'Lokasi asal produk tidak tersedia di data, ongkir tidak bisa dihitung. Hubungi redaksi/admin toko untuk melengkapi data lokasi produk.'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 })
    }

    // Keranjang berisi produk dari lebih dari 1 kota asal (penjual beda kota) -
    // JANGAN hitung ongkir dari 1 origin saja, pasti salah. Minta checkout.html
    // pisah jadi transaksi terpisah per kota asal.
    if (lokasiAsalSet.size > 1) {
      return new Response(JSON.stringify({
        opsi: [],
        error: 'MULTI_ORIGIN',
        message: `Keranjangmu berisi produk dari ${lokasiAsalSet.size} kota asal berbeda (${[...lokasiAsalSet].join(', ')}). Selesaikan checkout per kota asal secara terpisah supaya ongkirnya akurat.`
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 })
    }

    const originKota = [...lokasiAsalSet][0]
    const bisaDijangkauKurirMitra = kotaTerjangkauKurirMitra(originKota, kota_tujuan)

    const opsi: Array<{ kode: string; label: string; estimasi: string; harga: number; rekomendasi: boolean }> = []

    if (bisaDijangkauKurirMitra) {
      const totalBeratKg = totalBeratGram / 1000
      const klasterTujuan = KLASTER_KOTA_TERDEKAT[kota_tujuan] || [kota_tujuan]
      // Cari kurir yang berdomisili DI MANA SAJA dalam klaster kota
      // terdekat tujuan - bukan cuma yang persis sama string kota_tujuan.
      // Ini yang tadinya bikin kurir yang sudah terverifikasi tetap tidak
      // pernah kepakai kalau domisilinya di kota tetangga yang masih
      // wajar dijangkau.
      const { data: mitra } = await supabase
        .from('mitra_kurir')
        .select('id')
        .in('kota_domisili', klasterTujuan)
        .eq('status_verifikasi', 'TERVERIFIKASI')
        .gte('kapasitas_kg', totalBeratKg)
        .limit(1)

      if (mitra && mitra.length > 0) {
        const { data: tarif } = await supabase
          .from('tarif_kurir_zona')
          .select('*')
          .eq('kota', kota_tujuan)
          .eq('aktif', true)
          .maybeSingle()

        if (tarif) {
          const kelebihanKg = Math.max(0, Math.ceil((totalBeratGram - 1000) / 1000))
          const harga = tarif.tarif_dasar + (kelebihanKg * tarif.tarif_per_kg_tambahan)
          opsi.push({
            kode: 'kurir_lokal',
            label: 'Kurir Instan BICH',
            estimasi: tarif.estimasi_durasi || 'Sameday',
            harga,
            rekomendasi: true
          })
        }
      }
    }

    if (opsi.length === 0) {
      const BITESHIP_API_KEY = Deno.env.get('BITESHIP_API_KEY')

      if (!BITESHIP_API_KEY) {
        console.warn('BITESHIP_API_KEY belum dipasang di Supabase Secrets - Tier 2 (ekspedisi reguler) dilewati.')
      }

      if (BITESHIP_API_KEY) {
        const originPostal = KODE_POS[originKota]
        const destPostal = KODE_POS[kota_tujuan]

        if (!originPostal) {
          console.warn(`Kode pos tidak dikenal untuk kota asal: ${originKota}`)
        }

        if (originPostal && destPostal) {
          const res = await fetch('https://api.biteship.com/v1/rates/couriers', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${BITESHIP_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              origin_postal_code: originPostal,
              destination_postal_code: destPostal,
              couriers: 'jne,jnt,pos,sicepat',
              items: [{
                name: 'Produk BICH Mart',
                value: 50000,
                length: 10, width: 10, height: 10,
                weight: totalBeratGram
              }]
            }),
          })

          if (res.ok) {
            const biteship = await res.json()
            for (const p of biteship?.pricing || []) {
              opsi.push({
                kode: `ekspedisi_${p.courier_code}_${p.courier_service_code}`,
                label: `${p.courier_name} (${p.courier_service_name.toUpperCase()})`,
                estimasi: p.duration || '2-4 hari',
                harga: p.price,
                rekomendasi: false
              })
            }
            if (opsi.length > 0) opsi[0].rekomendasi = true
          } else {
            // Jangan expose body response Biteship mentah ke klien, cukup log server-side.
            console.error('Biteship API Error:', res.status, await res.text())
          }
        }
      }
    }

    return new Response(JSON.stringify({ opsi, total_berat_gram: totalBeratGram }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Pesan error dari Error() yang kita lempar sendiri di atas sudah aman
    // ditampilkan ke klien (tidak bocorin detail internal). Error lain di luar
    // itu (mis. exception tak terduga) dibalas generik.
    const message = error instanceof Error ? error.message : 'Terjadi kesalahan tidak diketahui'
    return new Response(JSON.stringify({ error: message, opsi: [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})