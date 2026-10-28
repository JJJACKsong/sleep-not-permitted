"""Render the sleep-not-permitted app icon.

Usage: python3 assets/generate-icon.py

Writes assets/icon-180.png and assets/icon-512.png next to this script.
A blue rounded tile with a white crescent moon cut by a prohibition slash:
blue halo keeps the slash legible where it crosses the moon.
"""
from PIL import Image, ImageDraw

BLUE_TOP=(92,126,252); BLUE_BOT=(58,78,224)
WHITE=(255,255,255,255)

def gradient(size, top, bot):
    img=Image.new("RGB",(size,size)); px=img.load()
    for y in range(size):
        t=y/(size-1)
        c=tuple(int(top[i]+(bot[i]-top[i])*t) for i in range(3))
        for x in range(size): px[x,y]=c
    return img

def rounded_mask(size, radius):
    m=Image.new("L",(size,size),0)
    ImageDraw.Draw(m).rounded_rectangle([0,0,size-1,size-1],radius=radius,fill=255)
    return m

def crescent_mask(size, cx,cy,R,ox,oy,cutR):
    m=Image.new("L",(size,size),0); d=ImageDraw.Draw(m)
    d.ellipse([cx-R,cy-R,cx+R,cy+R],fill=255)
    d.ellipse([cx+ox-cutR,cy+oy-cutR,cx+ox+cutR,cy+oy+cutR],fill=0)
    return m

def round_line(draw,p1,p2,width,fill):
    draw.line([p1,p2],fill=fill,width=width)
    r=width/2
    for x,y in (p1,p2): draw.ellipse([x-r,y-r,x+r,y+r],fill=fill)

def build(size, halo=True):
    S=size; k=S/180
    tile=Image.new("RGBA",(S,S),(0,0,0,0))
    tile.paste(gradient(S,BLUE_TOP,BLUE_BOT),(0,0),rounded_mask(S,int(44*k)))
    layer=Image.new("RGBA",(S,S),(0,0,0,0)); d=ImageDraw.Draw(layer)
    # moon
    layer.paste(Image.new("RGBA",(S,S),WHITE),(0,0),crescent_mask(S,int(83*k),int(100*k),int(48*k),int(25*k),int(-17*k),int(45*k)))
    p1=(35*k,145*k); p2=(148*k,32*k)
    if halo:
        halo_blue=gradient(S,BLUE_TOP,BLUE_BOT).convert("RGBA")
        hm=Image.new("L",(S,S),0); hd=ImageDraw.Draw(hm)
        round_line(hd,p1,p2,int(24*k),255)
        # paint halo with the tile color (approximately the local gradient) — use blurred local sample
        layer.paste(halo_blue,(0,0),hm)
    round_line(d,p1,p2,int(14*k),WHITE)
    return Image.alpha_composite(tile,layer)

import os
HERE = os.path.dirname(os.path.abspath(__file__))
for S in (180, 512):
    build(S).save(os.path.join(HERE, f"icon-{S}.png"))
print("ok")
