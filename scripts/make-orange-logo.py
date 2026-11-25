import sys
from PIL import Image, ImageDraw, ImageFilter
head = Image.open(sys.argv[1]).convert("RGBA")
head = head.crop(head.getbbox())
def tile(size, inset, radius, scale, out):
    S = size*4  # supersample
    c = Image.new("RGBA", (S, S), (0,0,0,0))
    x0, x1 = int(S*inset), int(S*(1-inset))
    w = x1-x0
    # warm orange vertical gradient
    grad = Image.new("RGBA", (w, w))
    top, bot = (247,164,82), (232,108,40)
    for y in range(w):
        t = y/(w-1)
        grad.paste(tuple(int(top[i]+(bot[i]-top[i])*t) for i in range(3))+(255,), (0,y,w,y+1))
    # soft highlight behind the face
    glow = Image.new("L", (w, w), 0); ImageDraw.Draw(glow).ellipse((w*.18, w*.22, w*.82, w*.86), fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(w*.08))
    grad = Image.composite(Image.new("RGBA",(w,w),(255,214,150,255)), grad, glow)
    m = Image.new("L", (w, w), 0); ImageDraw.Draw(m).rounded_rectangle((0,0,w-1,w-1), radius=int(w*radius), fill=255)
    c.paste(grad, (x0, x0), m)
    hw = int(w*scale); hh = int(hw*head.height/head.width)
    h = head.resize((hw, hh), Image.LANCZOS)
    sh = Image.new("RGBA", h.size, (90,30,0,0)); sh.putalpha(h.split()[3].point(lambda a: a*0.35))
    sh = sh.filter(ImageFilter.GaussianBlur(w*.015))
    hx = x0 + (w-hw)//2; hy = x0 + (w-hh)//2 + int(w*.02)
    layer = Image.new("RGBA", (S,S), (0,0,0,0))
    layer.paste(sh, (hx, hy+int(w*.02)), sh)
    layer.alpha_composite(h, (hx, hy))
    lm = Image.new("L",(S,S),0); lm.paste(m,(x0,x0))   # clip the cat to the tile
    layer.putalpha(Image.composite(layer.split()[3], Image.new("L",(S,S),0), lm))
    c.alpha_composite(layer)
    c.resize((size,size), Image.LANCZOS).save(out)
tile(1024, 0.0, 0.225, 0.84, sys.argv[2])     # web / PWA: full tile
tile(1024, 0.0977, 0.225, 0.84, sys.argv[3])  # macOS: Apple 824/1024 grid
