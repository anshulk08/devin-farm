#!/bin/sh
# ProRes 4444 MOVs, 4 s @30fps, from the PNGs. Cards: fade + subtle push. Lower thirds: alpha, slide-in + fade.
set -e; cd "$(dirname "$0")"; mkdir -p mov
for f in card-*.png; do n=${f%.png}
  ffmpeg -y -v error -loop 1 -framerate 30 -i $f -t 4 -vf "scale=2016:1134,zoompan=z='1+0.0004*on':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30,fade=in:0:15,fade=out:st=3.5:d=0.5,format=yuv444p10le" -c:v prores_ks -profile:v 4 -pix_fmt yuv444p10le mov/$n.mov
done
for f in lt-*.png; do n=${f%.png}
  ffmpeg -y -v error -loop 1 -framerate 30 -i $f -f lavfi -i "color=c=black@0:s=1920x1080:r=30,format=yuva444p" -filter_complex "[0]format=yuva444p,fade=in:st=0:d=0.4:alpha=1,fade=out:st=3.6:d=0.4:alpha=1[l];[1][l]overlay=x='-50*pow(max(0,1-t/0.5),2)':y=0:format=auto:shortest=1,format=yuva444p10le" -t 4 -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le mov/$n.mov
done
# architecture card (rendered via headless browser from ../architecture.svg)
ffmpeg -y -v error -loop 1 -framerate 30 -i architecture-1080p.png -t 5 -vf "fade=in:0:15,fade=out:st=4.5:d=0.5,format=yuv444p10le" -c:v prores_ks -profile:v 4 -pix_fmt yuv444p10le mov/card-06-architecture.mov
