/** Farm dashboard card. 1000x600, farm tycoon style. No emoji in fillText. */
async function farmCard(opts) {
  if (!canvasKit.available()) return null;
  const o = opts || {};
  const W = 1000, H = 600;
  try {
    const cv = canvasKit.create(W, H);
    const ctx = cv.ctx;

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#7fd2ff'); bg.addColorStop(0.5, '#ffd28a'); bg.addColorStop(1, '#ffb380');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    ctx.shadowColor = '#ffd700'; ctx.shadowBlur = 24;
    ctx.fillStyle = '#ffd700';
    ctx.beginPath(); ctx.arc(110, 90, 34, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath(); ctx.arc(250, 100, 24, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(280, 92, 30, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(310, 100, 24, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(720, 110, 26, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(750, 102, 32, 0, Math.PI * 2); ctx.fill();

    const soil = ctx.createLinearGradient(0, 380, 0, H);
    soil.addColorStop(0, '#5c4033'); soil.addColorStop(0.6, '#3e2723'); soil.addColorStop(1, '#2e1b14');
    ctx.fillStyle = soil;
    ctx.fillRect(0, 380, W, H - 380);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 2;
    for (let x = 0; x < W; x += 44) {
      ctx.beginPath(); ctx.moveTo(x, 380); ctx.lineTo(x + 20, H); ctx.stroke();
    }

    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const hr = 16;
    ctx.beginPath();
    ctx.moveTo(40 + hr, 20); ctx.lineTo(W - 40 - hr, 20);
    ctx.quadraticCurveTo(W - 40, 20, W - 40, 20 + hr);
    ctx.lineTo(W - 40, 84 - hr);
    ctx.quadraticCurveTo(W - 40, 84, W - 40 - hr, 84);
    ctx.lineTo(40 + hr, 84);
    ctx.quadraticCurveTo(40, 84, 40, 84 - hr);
    ctx.lineTo(40, 20 + hr);
    ctx.quadraticCurveTo(40, 20, 40 + hr, 20);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.35)'; ctx.lineWidth = 2; ctx.stroke();

    ctx.textAlign = 'center'; ctx.shadowColor = '#ffd700'; ctx.shadowBlur = 16;
    ctx.font = 'bold 44px serif'; ctx.fillStyle = '#fff';
    ctx.fillText('YOUR FARM', W / 2, 60);
    ctx.shadowBlur = 0;
    ctx.font = '17px sans-serif'; ctx.fillStyle = '#ffe0a3';
    ctx.fillText('Coins: ' + (o.coins || 0) + '   |   Seeds: ' + (o.seeds || 0) + '   |   Level: ' + (o.level || 1), W / 2, 86);

    const lx = 110, ly = 170, lr = 62;
    ctx.save(); ctx.shadowColor = '#8d6e63'; ctx.shadowBlur = 22;
    ctx.beginPath(); ctx.arc(lx, ly, lr + 6, 0, Math.PI * 2); ctx.lineWidth = 6; ctx.strokeStyle = '#8d6e63'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2); ctx.clip();
    const buf = o.pic ? await thumbBuffer(o.pic) : null;
    if (buf) {
      const img = await loadImage(buf);
      if (img) {
        const sc = Math.max(124 / img.width, 124 / img.height);
        ctx.drawImage(img, lx - img.width * sc / 2, ly - img.height * sc / 2, img.width * sc, img.height * sc);
      } else {
        ctx.fillStyle = '#4e342e'; ctx.fillRect(lx - lr, ly - lr, 124, 124);
      }
    } else {
      ctx.fillStyle = '#4e342e'; ctx.fillRect(lx - lr, ly - lr, 124, 124);
    }
    ctx.restore();
    ctx.font = 'bold 20px sans-serif'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Farmer', lx, ly + lr + 26);
    ctx.font = 'bold 26px sans-serif'; ctx.fillStyle = '#ffd700';
    ctx.fillText('LVL ' + (o.level || 1), lx, ly + lr + 56);

    const gridX = 300, gridY = 150, cell = 98, gap = 14;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const x = gridX + col * (cell + gap);
        const y = gridY + row * (cell + gap);
        ctx.fillStyle = '#4e342e';
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(x + 8, y + 8, cell - 16, cell - 16, 10);
        } else {
          ctx.arc(x + cell / 2, y + cell / 2, cell / 2 - 8, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 2; ctx.stroke();
        const hasCrop = (row + col) % 3 !== 0;
        if (hasCrop) {
          ctx.fillStyle = '#4caf50';
          ctx.beginPath(); ctx.arc(x + cell / 2, y + cell / 2 - 8, 10, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#8bc34a';
          ctx.beginPath(); ctx.moveTo(x + cell / 2, y + cell / 2 - 18); ctx.lineTo(x + cell / 2, y + cell / 2 - 4); ctx.strokeStyle = '#4caf50'; ctx.lineWidth = 3; ctx.stroke();
          const p = (row * 3 + col + 1) / 9;
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(x + 8, y + cell - 8, cell - 16, 5);
          ctx.fillStyle = '#ffd700';
          ctx.fillRect(x + 8, y + cell - 8, (cell - 16) * p, 5);
        } else {
          ctx.fillStyle = '#fff'; ctx.font = '14px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('EMPTY', x + cell / 2, y + cell / 2);
        }
      }
    }

    const rx = 700, ry = 150, rw = 260, rh = 260;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.moveTo(rx + 12, ry); ctx.lineTo(rx + rw - 12, ry);
    ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + 12);
    ctx.lineTo(rx + rw, ry + rh - 12);
    ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - 12, ry + rh);
    ctx.lineTo(rx + 12, ry + rh);
    ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - 12);
    ctx.lineTo(rx, ry + 12);
    ctx.quadraticCurveTo(rx, ry, rx + 12, ry);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.3)'; ctx.lineWidth = 2; ctx.stroke();

    ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('STORE', rx + 20, ry + 30);
    const storeItems = ['Wheat Seed', 'Corn Seed', 'Pumpkin Seed'];
    let yy = ry + 60;
    for (const item of storeItems) {
      ctx.fillStyle = '#ffe0a3'; ctx.font = '14px sans-serif';
      ctx.fillText(item, rx + 20, yy);
      ctx.fillStyle = '#ffd700'; ctx.font = '14px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText('15c', rx + rw - 20, yy);
      yy += 30;
    }

    ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('CROPS READY IN', rx + 20, yy + 16);
    ctx.fillStyle = '#b4e8ff'; ctx.font = '15px sans-serif';
    ctx.fillText('04m 12s', rx + 20, yy + 42);

    ctx.font = 'italic 16px serif'; ctx.fillStyle = '#ffd700'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Harvest today, feast tomorrow.', W / 2, H - 100);

    const fy = H - 40;
    const fdg = ctx.createLinearGradient(120, fy - 16, 880, fy - 16);
    fdg.addColorStop(0, 'transparent'); fdg.addColorStop(0.5, '#ffd700'); fdg.addColorStop(1, 'transparent');
    ctx.strokeStyle = fdg; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(120, fy - 16); ctx.lineTo(880, fy - 16); ctx.stroke();
    ctx.font = 'italic 16px serif'; ctx.fillStyle = '#c9a7ff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 2;
    ctx.fillText('Made with love by iKON BOT', W / 2, fy); ctx.shadowBlur = 0;
    ctx.font = '16px serif'; ctx.fillStyle = '#ffd700';
    ctx.fillText('• ──  ── •', W / 2, fy + 18);

    return cv.canvas.toDataURL('image/png');
  } catch (err) {
    const { error } = require('./helpers');
    error(`[CARD] farmCard failed: ${err.message}`);
    return null;
  }
}

module.exports = {
