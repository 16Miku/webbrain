# Emergency Box arama katmanı: zvec değerlendirmesi ve gerçek iyileştirme planı

## Context

Soru şuydu: apocalypse mode'daki Wikipedia ve Emergency Box aramasında mevcut yöntemler yerine
[alibaba/zvec](https://github.com/alibaba/zvec) veya [zvec-ai/zvec-grep](https://github.com/zvec-ai/zvec-grep)
kullanılabilir mi, komplikasyonlar ne olur.

Araştırma iki şeyi ortaya çıkardı ve ikisi de planın yönünü değiştiriyor:

1. **zvec bu ürüne giremez.** Ne runtime'da ne de build-time'da anlamlı bir rol üstlenemiyor (gerekçe aşağıda).
2. **Emergency Box'ta zaten semantik arama var.** Sorularda "anlamsal arama yok" şıkkını işaretlemiştin;
   kod öyle demiyor. E5 embedding + int8 vektör indeksi + BM25 ile RRF füzyonu hâlihazırda çalışıyor.
   Yani eksik olan semantik arama değil, **ANN indeksi ve boyut disiplini**.

Bu yüzden plan, zvec'i benimsemek yerine, işaretlediğin dört derdi (alaka, hız, boyut, bakım) mevcut
mimarinin üstünde ölçülebilir adımlarla çözmeye odaklanıyor. Kapsam senin seçimine uygun olarak
**önce Emergency Box**; Wikipedia/Xapian tarafına dokunulmuyor.

---

## 1. zvec neden elenmeli

| Bulgu | Kaynak |
|---|---|
| zvec C++ ile yazılmış, in-process bir vektör DB'si; Proxima motorunu sarmalıyor | README |
| Node SDK'sı saf JS değil: `@zvec/zvec` 72 KB'lık ince bir sarmalayıcı, iş `@zvec/bindings-{linux-x64,linux-arm64,win32-x64,darwin-arm64,+musl}` prebuilt native paketlerinde | npm registry |
| **wasm binding talebi upstream'de "not planned" olarak kapatılmış** — ve talep tam da bizim senaryomuzdu: "sunucuda indeks üret, tarayıcıda yükleyip ara" | [issue #25](https://github.com/alibaba/zvec/issues/25) |
| AVX2/AVX512 runtime dispatch, io_uring, WAL, mmap gibi wasm'a taşınması zor bağımlılıklar | README |
| `zvec-grep` bir Node ≥22 CLI/MCP aracı; `@vscode/ripgrep` native binary'sine ve `node-llama-cpp`'ye dayanıyor | npm registry |
| darwin-x64 binding'i yok (Intel Mac desteklenmiyor) | npm registry |

Kritik nokta: **build-time kullanım da kurtarmıyor.** zvec'in değeri native sorgu motoru ve kendi indeks
formatlarında (HNSW, IVF-RaBitQ). Tarayıcıya taşınabilen bir artifact üretmiyor. Build makinesinde zvec
indeksi üretsek bile onu okuyacak tarafı sıfırdan JS'te yazmamız gerekir — ki o zaman zvec'in katkısı
sıfıra iner.

**Tek savunulabilir zvec kullanımı:** korpus üreticisi (`build_emergency_pack.py`, ayrı repo
`webbrain-one/emergency-box-corpus`) Python ve zvec'in birincil SDK'sı Python. Oraya zvec'i bir
**değerlendirme oracle'ı** olarak koyabiliriz: aynı 251k E5 vektörünü yükleyip exact-KNN ground truth
üretmek, ANN'e geçtiğimizde recall kaybını ölçmek için. Dürüst olmak gerekirse bunu numpy ile ~20 satırda
da yaparız; zvec'in buradaki katkısı marjinal. Bağımlılık eklemeye değmez, ama istersen Aşama 0'da
ölçüm aracı olarak denenebilir.

`zvec-grep`'ten alınabilecek şey kod değil, **fikir**: hibrit BM25+vektör füzyonu (bizde RRF olarak zaten var)
ve yapı-farkında chunking. Yeni bir şey getirmiyor.

---

## 2. Bugün gerçekte ne var

Emergency Box retrieval hattı (hepsi `src/chrome/src/agent/` altında):

- **Leksikal:** SQLite FTS5, ağırlıklı BM25 — `offline-rag-index.js:20` (şema), `:60` (`bm25(passages, 0,0,0,7,0,2,0,0,4,1,0.6,...)`).
  İki geçişli: exact, sonuç < `RELAXED_RETRY_THRESHOLD` (5) ise prefix'li relaxed geçiş — `offline-retrieval.js:132,145-168`.
- **Semantik:** `Xenova/multilingual-e5-small`, 384 boyut, q8 — `offline-reranker.js:6-10`. Passage vektörleri
  **cihazda hesaplanmıyor**, korpus ZIP'inde hazır geliyor (`indexes/emergency-box-e5-q8.bin`, `WBVE5Q8` formatı,
  parser `offline-rag-index.js:404-451`). Sadece sorgu vektörü cihazda çıkarılıyor.
- **Arama döngüsü:** `searchEmergencyVector()` — `offline-rag-worker.js:281-330`. **Brute force, exact, ANN yok:**
  251.144 × 384 int8 dot product, her 4096 satırda iptal kontrolü.
- **Füzyon:** RRF k=60 — `offline-rag.js:630-665`, ardından çeşitlendirme `:705-737`.

Ölçülen sayılar:

| Metrik | Değer | Kaynak |
|---|---|---|
| Kurulu indeks toplamı | **1.149.755.424 B (~1,15 GB)** | `emergency-corpus-release.js:20-33` |
| — FTS5 db | **1.052.307.456 B (~1,05 GB)** | `docs/offline-rag-release-checklist.md:19-24` |
| — Vektör indeksi | 97.447.968 B (~97 MB) | aynı |
| Kurulu düz metin | 301.370.399 B | `emergency-corpus-release.js` |
| E5 model indirmesi | 140.461.908 B | `offline-reranker.js` |
| Passage sayısı | 251.144 | `emergency-corpus-release.js` |
| recall@1 / recall@5 / MRR | 0,554 / 0,875 / 0,685 | `scripts/benchmark-offline-relevance.mjs:33-39` |
| — zayıf kategoriler | **typo 0,357**, **inflection 0,393** | aynı |

**Dört derdin gerçek karşılığı:**

- **Boyut** — en büyük ve en somut kazanç burada. 1,05 GB'lık FTS5 db fil. Şema
  (`offline-rag-index.js:11-35`) ne `detail=` ne `content=` belirtiyor; yani FTS5 varsayılan
  `detail=full` ile **tam pozisyon indeksi** tutuyor *ve* `passages_content` gölge tablosunda
  **tüm metnin ikinci bir kopyasını** saklıyor — metin zaten ayrıca 301 MB olarak kurulduğu hâlde.
- **Hız** — sorgu başına ~96M int8 çarpma-toplama. Semantik timeout 30 s (`offline-retrieval.js:17`).
- **Alaka** — typo/inflection düşüklüğü leksikal bir zayıflık, vektör motoru sorunu değil.
- **Bakım** — el yazması ve testlerle çivilenmiş parçalar: `preferMatchingAgeCohort`, `AGE_COHORT_SYNONYMS`,
  `relaxedFts5Prefix`, `insertVectorWinner`, `cjkNgrams`.

---

## 3. Önerilen yaklaşım

### Aşama 0 — Ölçüm iskelesi (önce bu, kod değişikliği yok)

Hiçbir boyut iddiasına sayı üretmeden dokunma. Mevcut `scripts/benchmark-offline-relevance.mjs`
harness'ını ve vendor'daki SQLite'ı kullanarak bir varyant matrisi çıkar: her varyant için
**db boyutu + recall@1/@5 + MRR (kategori kırılımıyla) + sorgu p50/p95**.

Varyantlar: mevcut · `detail=column` · `detail=none` · contentless (`content=''`) + metin dışarıdan ·
`search_terms` kolonu çıkarılmış.

Bu aşama çıktısı olmadan Aşama 1'e geçilmez.

### Aşama 1 — Boyut: FTS5 db (hedef: 1,05 GB'ı belirgin şekilde aşağı çekmek)

İki bağımsız kaldıraç:

1. **`detail=` düşür.** Pozisyon verisi phrase ve NEAR sorguları için gerekli. `buildFts5Query()`
   (`offline-rag-index.js:330-353`) terimleri `OR` ile birleştiriyor ve tek token'ları tırnaklıyor
   (`'tourniquet bleeding'` → `'"tourniquet" OR "bleeding"'`), yani **çok kelimeli phrase üretmiyor** —
   `detail=none` uyumlu görünüyor. Prefix sorguları (`blee*`) `detail=none` ile çalışır. Aşama 0'da
   doğrula, çünkü `bm25()` skorlarının kayması recall'ı oynatabilir.
2. **Metin kopyasını kaldır.** Metin zaten `emergency-box-text/` altında kurulu. FTS5'i contentless
   veya external-content yapıp `body`/`title`'ı sorgu sonrası locator üzerinden okumak, gölge tablodaki
   duplikasyonu siler. Bu, `EMERGENCY_FTS_SEARCH_SQL`'in (`:44-64`) metin kolonlarını döndürme
   biçimini değiştirir — dokunulacak asıl yer burası.

### Aşama 2 — Hız + boyut: vektörler (97 MB, brute force)

İki aşamalı arama getir:

- Build-time'da her passage için **1 bit/boyut binary kod** üret: 384 bit = **48 B/passage** →
  ~12 MB (bugünkü 97 MB'ın ~1/8'i).
- Runtime'da önce popcount/Hamming ile kaba bir top-N (~2000) süz, sonra **sadece o N için** mevcut
  exact int8 dot product'ı çalıştır. Nihai sıralama exact kalır, tarama maliyeti ~100× düşer.
- Dokunulacak yer: `searchEmergencyVector()` (`offline-rag-worker.js:281-330`) ve `WBVE5Q8` formatının
  bir sonraki sürümü (`offline-rag-index.js:404-451`, `EMERGENCY_VECTOR_INDEX_FORMAT_VERSION`).

Bunu kendimiz yazıyoruz; zvec'in RaBitQ'sı burada referans olabilir ama bağımlılık gerekmiyor.

### Aşama 3 — Alaka: typo 0,357 ve inflection 0,393

Leksikal tarafın işi:

- **Typo:** yardımcı bir FTS5 `trigram` indeksi, yalnızca relaxed geçişte devreye giren.
- **Inflection:** korpus çok dilli; agresif stemming riskli. Önce ucuz olanı ölç — kısa sorgularda
  RRF'te leksikal ağırlığı düşürüp semantik tarafa yaslanmak (`offline-rag.js:630-665`).

Her iki değişiklik de Aşama 0 matrisindeki kategori kırılımıyla ölçülür; floor'ların altına düşen kabul edilmez.

### Aşama 4 — Bakım

`sqlite-vec` tek gerçekçi kütüphane adayı: saf C, bağımlılıksız, SQLite WASM'a **statik** derleniyor
(dinamik extension yüklenemiyor) ve `vec0` sanal tablolarıyla `insertVectorWinner` + `WBVE5Q8`'i emekli edebilir.
**Ama şimdi önerilmiyor:** hâlâ 0.1.7-alpha, kendisi de brute-force (yani Aşama 2'nin hız kazancını vermiyor),
ve testler `vendor/sqlite/index.mjs` ile `sqlite3.wasm`'ın SHA-256'sını çiviliyor (`test/run.js:33182`) —
wasm'ı yeniden derlemeyi gerektirir. Başka bir sebeple SQLite wasm yeniden derlenirse tekrar bakılır.

---

## 4. Dokunulacak dosyalar

| Dosya | Ne için |
|---|---|
| `src/chrome/src/agent/offline-rag-index.js` | FTS5 şeması (`:11-35`), arama SQL'i (`:44-64`), vektör format parser'ı (`:404-451`) |
| `src/chrome/src/agent/offline-rag-worker.js` | `searchEmergencyVector()` iki aşamalı hâle (`:281-330`), db import (`:201-239`) |
| `src/chrome/src/agent/offline-rag.js` | RRF ağırlıkları (`:630-665`), metin contentless'a geçerse hit birleştirme |
| `src/chrome/src/agent/offline-retrieval.js` | İki geçişli leksikal akış (`:132,145-168`) |
| `scripts/benchmark-offline-relevance.mjs` | Aşama 0 varyant matrisi; floor'lar (`:40`) |
| `src/firefox/src/agent/…` | Aynı dosyaların Firefox kopyaları — testler byte-identical olmalarını şart koşuyor |

**Repo dışı, en büyük komplikasyon:** indeks formatı `webbrain-one/emergency-box-corpus` reposundaki
`build_emergency_pack.py` tarafından üretiliyor. Aşama 1 ve 2 **koordineli bir korpus release'i** gerektirir
(501 MB ZIP) ve eski formatta kalmış kullanıcılar için `OFFLINE_RAG_INDEX_PROTOCOL_VERSION` (şu an 2)
bump'ı + manifest geçiş yolu ister. Bu, planın en pahalı kalemi ve zamanlamayı o repo belirler.

---

## 5. Doğrulama

Her aşama sonunda, sırayla:

1. `node scripts/benchmark-offline-relevance.mjs --verbose` — recall@1 ≥ 0,53 · recall@5 ≥ 0,85 · MRR ≥ 0,66
   floor'ları geçmeli (`:40`); kategori kırılımında typo/inflection **gerilememeli**.
2. `node scripts/benchmark-offline-rag.mjs` — indeks kurma ve sorgu gecikmesi regresyonu.
3. `node test/run.js` — özellikle `:33182` (FTS5 sorgu şekli + sqlite wasm SHA), `:33236` (`WBVE5Q8` düzeni),
   `:33271` (gerçek FTS5 bütünlüğü), `:34876` (iki geçişli akış). Format değişiyorsa bu assertion'lar
   bilerek güncellenecek — sessizce gevşetilmeyecek.
4. Gerçek korpusla kurulum dumanı: Emergency Box'ı kur, `docs/offline-rag-release-checklist.md`'deki
   sorguları (`airway breathing`, `急救 呼吸道`) çalıştır, kurulu indeks boyutunu ölç ve tabloya işle.
5. Chrome + Firefox'ta ayrı ayrı; MV3 tarafında offscreen yolunun (`offline-rag-host.js`) bozulmadığı görülecek.

## 6. Kapsam dışı

- Wikipedia/ZIM/Xapian tarafı (senin sıralamana göre sonraya).
- `emergency-pdf-search.js` ve `emergency-box.js:218-230`'daki substring taramaları — bunlar RAG değil,
  ayrı ve küçük yüzeyler; istenirse ayrı bir iş olarak ele alınır.
- zvec / zvec-grep bağımlılığı — yukarıdaki gerekçeyle benimsenmiyor.
