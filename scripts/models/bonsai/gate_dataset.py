"""Labelled questions for tiny Ask's screenshot gate (does a question need a
screenshot of the current page?).

Training and validation questions come from templates in eight languages.
The test set is separate: hand-written questions, including six languages the
probe never trains on (ja, ar, zh, nl, pl, ko), so it measures whether the
gate is language-independent rather than memorised. Training templates avoid
the test phrasings (no "Buy button", no flamingo, no melanoma).

    python scripts/models/bonsai/gate_dataset.py <out dir>   # writes train.json, validation.json, test.json
"""
import json
import random
import sys
from pathlib import Path

TEXT, NONE = 5000, 0  # page text length: a normal page, or almost none

# Per language: element and media nouns, hues, and templates by category.
# label 1 = needs a screenshot of the current page.
L = {
 'en': dict(
  el=['Sign up button', 'header', 'logo', 'banner', 'menu bar', 'background', 'search box', 'footer'],
  media=['photo', 'picture', 'image', 'chart', 'graph', 'diagram', 'map', 'illustration'],
  hue=['green', 'red', 'yellow', 'purple', 'black', 'orange'],
  visual=['What colour is the {el}?', 'Is the {el} {hue}?', 'What does the {media} on this page show?',
          'Describe the {media} next to the title.', 'How many people are in the {media}?',
          'What is written in the {media} at the top?', 'Does this page use a dark theme?', 'Where is the {el} on the screen?'],
  textless=['What is on this page?', 'What does this page show?', 'Explain this page.', 'What am I looking at here?'],
  mixed=['Does my attached picture match the {el} on this page?', 'Compare the photo I attached with the {media} here.'],
  text=['How much does the {plan} plan cost?', 'What does this page say about {topic}?', 'List the main points of this article.',
        'What is the phone number on this page?', 'When was this article published?', 'Translate the first paragraph.',
        'Summarise the article.', 'Is the {product} in stock?'],
  general=['What does a {animal} look like?', 'What colour is a {thing}?', 'Who was {person}?', 'What is {concept}?',
           'How do I {task}?', 'Explain {concept} simply.', 'Tell me a short joke.'],
  other_att=['What is in this picture?', 'Describe my photo.', 'What breed is the dog in my image?', 'Read the text in the screenshot I sent.'],
  other_link=['Summarise {url}.', 'What colour is the logo on {url}?'],
  plan=['Basic', 'Team', 'Enterprise'], topic=['shipping', 'refunds', 'the warranty'], product=['blue kettle', 'desk lamp'],
  animal=['zebra', 'peacock', 'axolotl'], thing=['ruby', 'banana', 'lime'], person=['Marie Curie', 'Alan Turing', 'Frida Kahlo'],
  concept=['inflation', 'photosynthesis', 'a black hole'], task=['change a tyre', 'boil an egg', 'reset a router']),
 'tr': dict(
  el=['Kayıt ol butonu', 'üst menü', 'logo', 'afiş', 'arka plan', 'arama kutusu', 'alt bilgi'],
  media=['fotoğraf', 'resim', 'görsel', 'grafik', 'diyagram', 'harita', 'çizim'],
  hue=['yeşil', 'kırmızı', 'sarı', 'mor', 'siyah', 'turuncu'],
  visual=['{el} ne renk?', '{el} {hue} mi?', 'Bu sayfadaki {media} neyi gösteriyor?', 'Başlığın yanındaki {media} nasıl?',
          '{media} içinde kaç kişi var?', 'Üstteki {media} üzerinde ne yazıyor?', 'Bu sayfa koyu temalı mı?', '{el} ekranın neresinde?'],
  textless=['Bu sayfada ne var?', 'Bu sayfa ne gösteriyor?', 'Bu sayfayı açıkla.', 'Burada neye bakıyorum?'],
  mixed=['Eklediğim resim bu sayfadaki {el} ile aynı mı?', 'Gönderdiğim fotoğrafı buradaki {media} ile karşılaştır.'],
  text=['{plan} paketi ne kadar?', 'Bu sayfa {topic} hakkında ne diyor?', 'Bu yazının ana noktalarını listele.',
        'Bu sayfadaki telefon numarası ne?', 'Bu makale ne zaman yayımlandı?', 'İlk paragrafı çevir.', 'Makaleyi özetle.', '{product} stokta var mı?'],
  general=['{animal} neye benzer?', '{thing} ne renktir?', '{person} kimdir?', '{concept} nedir?', 'Nasıl {task}?',
           '{concept} konusunu basitçe anlat.', 'Bana kısa bir fıkra anlat.'],
  other_att=['Bu resimde ne var?', 'Fotoğrafımı anlat.', 'Gönderdiğim resimdeki köpek hangi cins?', 'Gönderdiğim ekran görüntüsündeki yazıyı oku.'],
  other_link=['{url} adresini özetle.', '{url} sayfasındaki logo ne renk?'],
  plan=['Temel', 'Ekip', 'Kurumsal'], topic=['kargo', 'iade', 'garanti'], product=['mavi su ısıtıcısı', 'masa lambası'],
  animal=['Zebra', 'Tavus kuşu', 'Aksolotl'], thing=['Yakut', 'Muz', 'Misket limonu'], person=['Marie Curie', 'Alan Turing', 'Frida Kahlo'],
  concept=['Enflasyon', 'Fotosentez', 'Kara delik'], task=['lastik değiştirilir', 'yumurta haşlanır', 'modem sıfırlanır']),
 'de': dict(
  el=['Registrieren-Button', 'Kopfzeile', 'Logo', 'Banner', 'Menüleiste', 'Hintergrund', 'Suchfeld'],
  media=['Foto', 'Bild', 'Diagramm', 'Grafik', 'Karte', 'Illustration'],
  hue=['grün', 'rot', 'gelb', 'lila', 'schwarz', 'orange'],
  visual=['Welche Farbe hat das {el}?', 'Ist das {el} {hue}?', 'Was zeigt das {media} auf dieser Seite?', 'Beschreibe das {media} neben dem Titel.',
          'Wie viele Personen sind auf dem {media}?', 'Was steht oben im {media}?', 'Hat diese Seite ein dunkles Design?', 'Wo ist das {el} auf dem Bildschirm?'],
  textless=['Was ist auf dieser Seite?', 'Was zeigt diese Seite?', 'Erkläre diese Seite.', 'Was sehe ich hier?'],
  mixed=['Passt mein angehängtes Bild zum {el} auf dieser Seite?', 'Vergleiche mein Foto mit dem {media} hier.'],
  text=['Was kostet der Tarif {plan}?', 'Was steht auf dieser Seite über {topic}?', 'Nenne die wichtigsten Punkte des Artikels.',
        'Wie lautet die Telefonnummer auf dieser Seite?', 'Wann wurde dieser Artikel veröffentlicht?', 'Übersetze den ersten Absatz.',
        'Fasse den Artikel zusammen.', 'Ist der {product} auf Lager?'],
  general=['Wie sieht ein {animal} aus?', 'Welche Farbe hat eine {thing}?', 'Wer war {person}?', 'Was ist {concept}?',
           'Wie kann ich {task}?', 'Erkläre {concept} einfach.', 'Erzähl mir einen kurzen Witz.'],
  other_att=['Was ist auf diesem Bild?', 'Beschreibe mein Foto.', 'Welche Rasse hat der Hund auf meinem Bild?', 'Lies den Text in meinem Screenshot.'],
  other_link=['Fasse {url} zusammen.', 'Welche Farbe hat das Logo auf {url}?'],
  plan=['Basis', 'Team', 'Enterprise'], topic=['Versand', 'Rückgabe', 'Garantie'], product=['blaue Wasserkocher', 'Schreibtischlampe'],
  animal=['Zebra', 'Pfau', 'Axolotl'], thing=['Banane', 'Limette', 'Tomate'], person=['Marie Curie', 'Alan Turing', 'Frida Kahlo'],
  concept=['Inflation', 'Photosynthese', 'ein Schwarzes Loch'], task=['einen Reifen wechseln', 'ein Ei kochen', 'den Router zurücksetzen']),
 'es': dict(
  el=['botón de registro', 'encabezado', 'logotipo', 'banner', 'menú', 'fondo', 'cuadro de búsqueda'],
  media=['foto', 'imagen', 'gráfico', 'diagrama', 'mapa', 'ilustración'],
  hue=['verde', 'rojo', 'amarillo', 'morado', 'negro', 'naranja'],
  visual=['¿De qué color es el {el}?', '¿El {el} es {hue}?', '¿Qué muestra la {media} de esta página?', 'Describe la {media} junto al título.',
          '¿Cuántas personas hay en la {media}?', '¿Qué pone en la {media} de arriba?', '¿Esta página usa un tema oscuro?', '¿Dónde está el {el} en la pantalla?'],
  textless=['¿Qué hay en esta página?', '¿Qué muestra esta página?', 'Explica esta página.', '¿Qué estoy viendo aquí?'],
  mixed=['¿Mi imagen adjunta coincide con el {el} de esta página?', 'Compara la foto que adjunté con la {media} de aquí.'],
  text=['¿Cuánto cuesta el plan {plan}?', '¿Qué dice esta página sobre {topic}?', 'Enumera los puntos principales del artículo.',
        '¿Cuál es el teléfono de esta página?', '¿Cuándo se publicó este artículo?', 'Traduce el primer párrafo.', 'Resume el artículo.', '¿Hay {product} en stock?'],
  general=['¿Cómo es un {animal}?', '¿De qué color es un {thing}?', '¿Quién fue {person}?', '¿Qué es {concept}?',
           '¿Cómo puedo {task}?', 'Explica {concept} de forma sencilla.', 'Cuéntame un chiste corto.'],
  other_att=['¿Qué hay en esta imagen?', 'Describe mi foto.', '¿De qué raza es el perro de mi imagen?', 'Lee el texto de la captura que envié.'],
  other_link=['Resume {url}.', '¿De qué color es el logotipo de {url}?'],
  plan=['Básico', 'Equipo', 'Empresa'], topic=['envíos', 'devoluciones', 'la garantía'], product=['hervidor azul', 'lámpara de escritorio'],
  animal=['cebra', 'pavo real', 'ajolote'], thing=['rubí', 'plátano', 'limón'], person=['Marie Curie', 'Alan Turing', 'Frida Kahlo'],
  concept=['la inflación', 'la fotosíntesis', 'un agujero negro'], task=['cambiar una rueda', 'cocer un huevo', 'reiniciar el router']),
 'fr': dict(
  el=["bouton d'inscription", 'en-tête', 'logo', 'bandeau', 'menu', 'arrière-plan', 'champ de recherche'],
  media=['photo', 'image', 'graphique', 'diagramme', 'carte', 'illustration'],
  hue=['vert', 'rouge', 'jaune', 'violet', 'noir', 'orange'],
  visual=['De quelle couleur est le {el} ?', 'Le {el} est-il {hue} ?', 'Que montre la {media} de cette page ?', 'Décris la {media} à côté du titre.',
          'Combien de personnes y a-t-il sur la {media} ?', "Qu'est-il écrit sur la {media} en haut ?", 'Cette page utilise-t-elle un thème sombre ?',
          "Où se trouve le {el} à l'écran ?"],
  textless=["Qu'y a-t-il sur cette page ?", 'Que montre cette page ?', 'Explique cette page.', 'Que suis-je en train de regarder ici ?'],
  mixed=['Mon image jointe correspond-elle au {el} de cette page ?', "Compare la photo jointe avec la {media} d'ici."],
  text=['Combien coûte la formule {plan} ?', 'Que dit cette page sur {topic} ?', "Liste les points principaux de l'article.",
        'Quel est le numéro de téléphone sur cette page ?', 'Quand cet article a-t-il été publié ?', 'Traduis le premier paragraphe.',
        "Résume l'article.", 'La {product} est-elle en stock ?'],
  general=['À quoi ressemble un {animal} ?', 'De quelle couleur est un {thing} ?', 'Qui était {person} ?', "Qu'est-ce que {concept} ?",
           'Comment {task} ?', 'Explique {concept} simplement.', 'Raconte-moi une blague courte.'],
  other_att=["Qu'y a-t-il sur cette image ?", 'Décris ma photo.', 'De quelle race est le chien sur mon image ?', "Lis le texte de la capture d'écran envoyée."],
  other_link=['Résume {url}.', 'De quelle couleur est le logo de {url} ?'],
  plan=['Essentiel', 'Équipe', 'Entreprise'], topic=['la livraison', 'les retours', 'la garantie'], product=['bouilloire bleue', 'lampe de bureau'],
  animal=['zèbre', 'paon', 'axolotl'], thing=['rubis', 'citron vert', 'kiwi'], person=['Marie Curie', 'Alan Turing', 'Frida Kahlo'],
  concept=["l'inflation", 'la photosynthèse', 'un trou noir'], task=['changer un pneu', 'cuire un œuf', 'réinitialiser la box']),
 'it': dict(
  el=['pulsante Iscriviti', 'intestazione', 'logo', 'banner', 'menu', 'sfondo', 'casella di ricerca'],
  media=['foto', 'immagine', 'grafico', 'diagramma', 'mappa', 'illustrazione'],
  hue=['verde', 'rosso', 'giallo', 'viola', 'nero', 'arancione'],
  visual=['Di che colore è il {el}?', 'Il {el} è {hue}?', 'Cosa mostra la {media} in questa pagina?', 'Descrivi la {media} accanto al titolo.',
          'Quante persone ci sono nella {media}?', "Cosa c'è scritto nella {media} in alto?", 'Questa pagina usa un tema scuro?', "Dov'è il {el} sullo schermo?"],
  textless=["Cosa c'è in questa pagina?", 'Cosa mostra questa pagina?', 'Spiega questa pagina.', 'Cosa sto guardando qui?'],
  mixed=["L'immagine che ho allegato corrisponde al {el} di questa pagina?", 'Confronta la foto allegata con la {media} qui.'],
  text=['Quanto costa il piano {plan}?', 'Cosa dice questa pagina su {topic}?', "Elenca i punti principali dell'articolo.",
        'Qual è il numero di telefono in questa pagina?', 'Quando è uscito questo articolo?', 'Traduci il primo paragrafo.', "Riassumi l'articolo.",
        'Il {product} è disponibile?'],
  general=["Che aspetto ha un {animal}?", 'Di che colore è un {thing}?', 'Chi era {person}?', "Che cos'è {concept}?",
           'Come si fa a {task}?', 'Spiega {concept} in modo semplice.', 'Raccontami una barzelletta breve.'],
  other_att=["Cosa c'è in questa immagine?", 'Descrivi la mia foto.', "Di che razza è il cane nella mia immagine?", 'Leggi il testo nello screenshot che ho inviato.'],
  other_link=['Riassumi {url}.', 'Di che colore è il logo su {url}?'],
  plan=['Base', 'Team', 'Azienda'], topic=['le spedizioni', 'i resi', 'la garanzia'], product=['bollitore blu', 'lampada da scrivania'],
  animal=['zebra', 'pavone', 'axolotl'], thing=['rubino', 'limone', 'kiwi'], person=['Marie Curie', 'Alan Turing', 'Frida Kahlo'],
  concept=["l'inflazione", 'la fotosintesi', 'un buco nero'], task=['cambiare una gomma', 'cuocere un uovo', 'resettare il router']),
 'pt': dict(
  el=['botão Cadastrar', 'cabeçalho', 'logotipo', 'banner', 'menu', 'fundo', 'caixa de pesquisa'],
  media=['foto', 'imagem', 'gráfico', 'diagrama', 'mapa', 'ilustração'],
  hue=['verde', 'vermelho', 'amarelo', 'roxo', 'preto', 'laranja'],
  visual=['De que cor é o {el}?', 'O {el} é {hue}?', 'O que mostra a {media} desta página?', 'Descreva a {media} ao lado do título.',
          'Quantas pessoas há na {media}?', 'O que está escrito na {media} no topo?', 'Esta página usa um tema escuro?', 'Onde fica o {el} na tela?'],
  textless=['O que há nesta página?', 'O que esta página mostra?', 'Explique esta página.', 'O que estou vendo aqui?'],
  mixed=['A imagem que anexei combina com o {el} desta página?', 'Compare a foto anexada com a {media} daqui.'],
  text=['Quanto custa o plano {plan}?', 'O que esta página diz sobre {topic}?', 'Liste os pontos principais do artigo.',
        'Qual é o telefone nesta página?', 'Quando este artigo foi publicado?', 'Traduza o primeiro parágrafo.', 'Resuma o artigo.', 'A {product} está em estoque?'],
  general=['Como é um {animal}?', 'De que cor é um {thing}?', 'Quem foi {person}?', 'O que é {concept}?',
           'Como faço para {task}?', 'Explique {concept} de forma simples.', 'Conte uma piada curta.'],
  other_att=['O que há nesta imagem?', 'Descreva minha foto.', 'De que raça é o cachorro na minha imagem?', 'Leia o texto da captura de tela que enviei.'],
  other_link=['Resuma {url}.', 'De que cor é o logotipo em {url}?'],
  plan=['Básico', 'Equipe', 'Empresa'], topic=['frete', 'devoluções', 'a garantia'], product=['chaleira azul', 'luminária de mesa'],
  animal=['zebra', 'pavão', 'axolote'], thing=['rubi', 'limão', 'kiwi'], person=['Marie Curie', 'Alan Turing', 'Frida Kahlo'],
  concept=['a inflação', 'a fotossíntese', 'um buraco negro'], task=['trocar um pneu', 'cozinhar um ovo', 'reiniciar o roteador']),
 'ru': dict(
  el=['кнопка «Регистрация»', 'шапка сайта', 'логотип', 'баннер', 'меню', 'фон', 'поле поиска'],
  media=['фото', 'картинка', 'изображение', 'график', 'диаграмма', 'карта'],
  hue=['зелёный', 'красный', 'жёлтый', 'фиолетовый', 'чёрный', 'оранжевый'],
  visual=['Какого цвета {el}?', '{el} — {hue}?', 'Что показывает {media} на этой странице?', 'Опиши {media} рядом с заголовком.',
          'Сколько людей на {media}?', 'Что написано на {media} вверху?', 'На этой странице тёмная тема?', 'Где {el} на экране?'],
  textless=['Что на этой странице?', 'Что показывает эта страница?', 'Объясни эту страницу.', 'На что я здесь смотрю?'],
  mixed=['Совпадает ли моя прикреплённая картинка с элементом «{el}» на этой странице?', 'Сравни моё фото с тем, что здесь: {media}.'],
  text=['Сколько стоит тариф «{plan}»?', 'Что эта страница говорит о теме «{topic}»?', 'Перечисли главные мысли статьи.',
        'Какой номер телефона на этой странице?', 'Когда опубликована эта статья?', 'Переведи первый абзац.', 'Кратко перескажи статью.',
        '{product} есть в наличии?'],
  general=['Как выглядит {animal}?', 'Какого цвета {thing}?', 'Кем был(а) {person}?', 'Что такое {concept}?',
           'Как {task}?', 'Объясни простыми словами: {concept}.', 'Расскажи короткий анекдот.'],
  other_att=['Что на этой картинке?', 'Опиши моё фото.', 'Какой породы собака на моём изображении?', 'Прочитай текст на скриншоте, который я отправил.'],
  other_link=['Перескажи {url}.', 'Какого цвета логотип на {url}?'],
  plan=['Базовый', 'Команда', 'Бизнес'], topic=['доставка', 'возврат', 'гарантия'], product=['Синий чайник', 'Настольная лампа'],
  animal=['зебра', 'павлин', 'аксолотль'], thing=['рубин', 'банан', 'лайм'], person=['Мария Кюри', 'Алан Тьюринг', 'Фрида Кало'],
  concept=['инфляция', 'фотосинтез', 'чёрная дыра'], task=['поменять колесо', 'сварить яйцо', 'сбросить роутер']),
}
URLS = ['https://news.example/launch', 'https://brand.example/about', 'https://shop.example/item/42']

# Hand-written test questions, never produced by the templates. Six languages
# appear only here.
TEST = [
 (1, 'en', 'What color is the Buy button?', TEXT, 0, 0), (1, 'en', 'What does the chart on this page show?', TEXT, 0, 0),
 (1, 'en', 'Describe the photo at the top.', TEXT, 0, 0), (1, 'en', 'Is the logo red or blue?', TEXT, 0, 0),
 (1, 'tr', 'Satın al butonu ne renk?', TEXT, 0, 0), (1, 'tr', 'Fotoğraftaki kupa ne renk?', TEXT, 0, 0),
 (1, 'de', 'Welche Farbe hat der Kaufen-Knopf?', TEXT, 0, 0), (1, 'es', '¿Qué muestra la foto de esta página?', TEXT, 0, 0),
 (1, 'fr', 'Que montre le graphique sur cette page ?', TEXT, 0, 0), (1, 'it', 'Di che colore è il pulsante Acquista?', TEXT, 0, 0),
 (1, 'en', 'What is on this page?', NONE, 0, 0), (1, 'de', 'Was ist auf dieser Seite zu sehen?', NONE, 0, 0),
 (1, 'en', 'Compare the attached image with the logo on this page.', TEXT, 1, 0),
 (0, 'en', 'How much is the Pro plan per month?', TEXT, 0, 0), (0, 'en', 'Summarize this page in two sentences.', TEXT, 0, 0),
 (0, 'en', 'When did the repairs end?', TEXT, 0, 0), (0, 'tr', 'Pro planı aylık ne kadar?', TEXT, 0, 0),
 (0, 'de', 'Fasse diese Seite zusammen.', TEXT, 0, 0), (0, 'es', '¿Cuánto cuesta el plan Pro al mes?', TEXT, 0, 0),
 (0, 'en', 'What does melanoma look like?', TEXT, 0, 0), (0, 'en', 'Explain what melanoma looks like.', NONE, 0, 0),
 (0, 'en', 'Who was Ada Lovelace?', NONE, 0, 0), (0, 'en', 'What color is a flamingo?', TEXT, 0, 0),
 (0, 'tr', 'Melanom nasıl görünür?', TEXT, 0, 0), (0, 'de', 'Wie sieht ein Flamingo aus?', TEXT, 0, 0),
 (0, 'en', 'What is in this image?', TEXT, 1, 0), (0, 'tr', 'Bu resimde ne var?', TEXT, 1, 0),
 (0, 'en', 'What color is the logo at https://brand.example/about?', TEXT, 0, 1),
 # Languages the probe never trains on.
 (1, 'ja', 'このページの画像には何が写っていますか？', TEXT, 0, 0), (1, 'ja', '購入ボタンは何色ですか？', TEXT, 0, 0),
 (1, 'ja', 'このページには何がありますか？', NONE, 0, 0), (0, 'ja', 'このページを要約してください。', TEXT, 0, 0),
 (0, 'ja', '富士山の高さは？', TEXT, 0, 0), (0, 'ja', 'フラミンゴは何色ですか？', TEXT, 0, 0),
 (1, 'ar', 'ما لون زر الشراء في هذه الصفحة؟', TEXT, 0, 0), (1, 'ar', 'ماذا يظهر في الصورة أعلى الصفحة؟', TEXT, 0, 0),
 (0, 'ar', 'لخص هذه الصفحة.', TEXT, 0, 0), (0, 'ar', 'من هو ابن سينا؟', TEXT, 0, 0), (0, 'ar', 'ما هذا في الصورة التي أرفقتها؟', TEXT, 1, 0),
 (1, 'zh', '购买按钮是什么颜色？', TEXT, 0, 0), (1, 'zh', '这个页面上的图表显示了什么？', TEXT, 0, 0),
 (0, 'zh', '总结一下这篇文章。', TEXT, 0, 0), (0, 'zh', '长城有多长？', TEXT, 0, 0), (0, 'zh', '火烈鸟是什么颜色的？', NONE, 0, 0),
 (1, 'nl', 'Welke kleur heeft de Koop-knop?', TEXT, 0, 0), (1, 'nl', 'Wat staat er op deze pagina?', NONE, 0, 0),
 (0, 'nl', 'Hoeveel kost het Pro-abonnement per maand?', TEXT, 0, 0), (0, 'nl', 'Wie was Rembrandt?', TEXT, 0, 0),
 (1, 'pl', 'Jakiego koloru jest przycisk Kup?', TEXT, 0, 0), (1, 'pl', 'Co przedstawia zdjęcie na tej stronie?', TEXT, 0, 0),
 (0, 'pl', 'Streść ten artykuł.', TEXT, 0, 0), (0, 'pl', 'Jak wygląda flaming?', TEXT, 0, 0),
 (1, 'ko', '구매 버튼은 무슨 색인가요?', TEXT, 0, 0), (1, 'ko', '이 페이지의 사진에는 무엇이 있나요?', TEXT, 0, 0),
 (0, 'ko', '이 페이지를 요약해 주세요.', TEXT, 0, 0), (0, 'ko', '세종대왕은 누구인가요?', TEXT, 0, 0),
]


def fill(template, slots, rng):
    out = template
    for key in ('el', 'media', 'hue', 'plan', 'topic', 'product', 'animal', 'thing', 'person', 'concept', 'task'):
        while '{' + key + '}' in out:
            out = out.replace('{' + key + '}', rng.choice(slots[key]), 1)
    while '{url}' in out:
        out = out.replace('{url}', rng.choice(URLS), 1)
    return out[0].upper() + out[1:] if out[0].islower() else out


def generate(seed=7):
    rng = random.Random(seed)
    rows = []
    for lang, slots in L.items():
        def add(label, kind, template, page_chars, attached=0, linked=0, copies=1):
            for _ in range(copies):
                rows.append(dict(label=label, kind=kind, language=lang, question=fill(template, slots, rng),
                                 pageChars=page_chars, imageAttachment=bool(attached), linkedPage=bool(linked)))
        for template in slots['visual']:
            add(1, 'visual', template, rng.choice([TEXT, TEXT, 1800]), copies=2)
        for template in slots['textless']:
            add(1, 'textless_page', template, NONE)
            add(0, 'page_with_text', template.replace('{x}', ''), TEXT)  # the same page question on a normal page
        for template in slots['mixed']:
            add(1, 'mixed', template, TEXT, attached=1)
        for template in slots['text']:
            add(0, 'text', template, rng.choice([TEXT, 2500]), copies=2)
        for template in slots['general']:
            add(0, 'general', template, rng.choice([TEXT, NONE]), copies=2)
        for template in slots['other_att']:
            add(0, 'attachment', template, TEXT, attached=1)
        for template in slots['other_link']:
            add(0, 'linked', template, TEXT, linked=1)
    # One row per distinct question and context.
    seen, unique = set(), []
    for row in rows:
        key = (row['question'], row['pageChars'], row['imageAttachment'], row['linkedPage'])
        if key not in seen:
            seen.add(key)
            unique.append(row)
    return unique


def main(out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    rows = generate()
    rng = random.Random(11)
    rng.shuffle(rows)
    cut = int(len(rows) * 0.8)
    test = [dict(label=label, kind='test', language=lang, question=q, pageChars=chars, imageAttachment=bool(att), linkedPage=bool(link))
            for label, lang, q, chars, att, link in TEST]
    for name, part in (('train', rows[:cut]), ('validation', rows[cut:]), ('test', test)):
        (out / f'{name}.json').write_text(json.dumps(part, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        print(name, len(part), 'positive', sum(r['label'] for r in part))


if __name__ == '__main__':
    main(sys.argv[1])
