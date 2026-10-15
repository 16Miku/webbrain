"""Browser-free renderer for slide 14, using the gallery's vendored fonts.
Run: python3 render-record.py (requires Pillow).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

DIR = Path(__file__).resolve().parent
S = 2
W, H = 1280, 800
ink, muted, accent = '#171827', '#586174', '#6757ff'

def font(name, size, weight):
    f = ImageFont.truetype(str(DIR / 'fonts' / name), round(size*S))
    axes = f.get_variation_axes()
    vals = [a['default'] for a in axes]
    for i, a in enumerate(axes):
        if a['name'] == b'Weight': vals[i] = weight
        if a['name'] == b'Optical Size': vals[i] = 72
    f.set_variation_by_axes(vals)
    return f

def text(draw, xy, value, size=24, color=ink, family='sans', weight=650, anchor='lt'):
    names = {'sans':'instrument-sans-var.woff2', 'display':'bricolage-grotesque-var.woff2', 'mono':'geist-mono-var.woff2'}
    draw.text(tuple(round(v*S) for v in xy), value, font=font(names[family],size,weight), fill=color, anchor=anchor)

def rect(draw, box, fill, radius=0, outline=None):
    draw.rounded_rectangle(tuple(round(v*S) for v in box), radius=round(radius*S), fill=fill, outline=outline, width=S)

im = Image.new('RGB', (W*S,H*S))
pix = im.load()
a, b = (245,247,255), (255,243,247)
for y in range(H*S):
    for x in range(W*S):
        t=(x/(W*S)+y/(H*S))/2
        pix[x,y]=tuple(round(a[i]*(1-t)+b[i]*t) for i in range(3))
im=im.convert('RGBA')
shadow=Image.new('RGBA', im.size)
sd=ImageDraw.Draw(shadow)
rect(sd,(679,159,1249,703),(46,42,90,42),32)
im=Image.alpha_composite(im,shadow.filter(ImageFilter.GaussianBlur(35*S)))
d=ImageDraw.Draw(im)
text(d,(59,264),'Keep the',76,family='display',weight=800)
text(d,(59,343),'whole call.',76,family='display',weight=800)
text(d,(59,449),'Record Zoom calls, demos,',29,muted,weight=520)
text(d,(59,488),'and more. Just type',29,muted,weight=520)
text(d,(59,529),'/record.',29,accent,'mono')
# Focused card, gently rotated like the other feature slides.
card=Image.new('RGBA',(574*S,530*S))
c=ImageDraw.Draw(card)
rect(c,(0,0,573,529),'#ffffff',32,'#dfe0e9')
text(c,(34,35),'VIDEO RECORDING',15,muted,'mono')
rect(c,(384,41,395,52),'#e54f62',6)
text(c,(406,36),'REC · 12:34',15,'#cc4456','mono')
rect(c,(34,75,540,395),'#202636',20)
people=[('AL','Alex','#d9d1fb','#6757b7'),('JM','Jamie','#cde9df','#337b67'),('SK','Sam','#f7daca','#ad6948'),('YOU','You','#d1dff8','#4b6eae')]
for i,(initials,name,bg,fg) in enumerate(people):
    x,y=49+(i%2)*245,90+(i//2)*139
    rect(c,(x,y,x+232,y+129),bg,11)
    rect(c,(x+84,y+27,x+148,y+91),fg,32)
    text(c,(x+116,y+59),initials,19 if i==3 else 26,'#fff',anchor='mm')
    rect(c,(x+8,y+102,x+68,y+123),'#343b4d',4)
    text(c,(x+15,y+106),name,13,'#fff')
c.polygon([(51*S,369*S),(51*S,383*S),(62*S,376*S)],fill='#e1e6ef')
rect(c,(77,373,455,378),'#51596c',3)
rect(c,(77,373,323,378),'#b1a3ff',3)
text(c,(474,368),'12:34',14,'#e1e6ef')
rect(c,(34,419,540,497),'#fbfbfe',19,'#dfe0e9')
text(c,(54,443),'/record',27,family='mono')
rect(c,(190,441,193,470),accent,1)
rect(c,(473,434,522,483),accent,14)
text(c,(497,457),'↑',27,'#fff',weight=700,anchor='mm')
card=card.rotate(-1,Image.Resampling.BICUBIC,expand=True)
im.alpha_composite(card,(round(664*S),round(123*S)))
d=ImageDraw.Draw(im)
text(d,(697,689),'TAB: /record',16,muted,'mono')
text(d,(697,720),'SCREEN: /record --full-screen',16,muted,'mono')
im.convert('RGB').resize((W,H),Image.Resampling.LANCZOS).save(DIR/'14-record-video.png')
print('Saved 14-record-video.png (1280×800)')
