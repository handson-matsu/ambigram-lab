'use strict';
(() => {
  const $ = (selector) => document.querySelector(selector);
  const editor = $('#editor');
  const preview = $('#preview');
  const ctx = editor.getContext('2d', { willReadFrequently: true });
  const previewCtx = preview.getContext('2d');
  const size = editor.width;
  const widths = { brush: 24, pen: 5, eraser: 88 };
  const widthRanges = { brush: [1, 80], pen: [1, 80], eraser: [8, 160] };
  const toolNames = { brush: '筆', pen: 'ペン', eraser: '消しゴム' };
  let tool = 'brush';
  let color = '#202333';
  let transform = '180';
  let activePointer = null;
  let lastPoint = null;
  let lastMidpoint = null;
  let frame = null;
  let brushStroke = null;
  // A bounded bitmap history keeps every operation exact, including erasure and rotation.
  const historyLimit = 30;
  const initialState = ctx.getImageData(0, 0, size, size);
  let history = [initialState];
  let historyIndex = 0;
  let dirty = false;
  const announce = (message) => { $('#status').textContent = message; };

  function updatePreview() {
    frame = null;
    previewCtx.clearRect(0, 0, size, size);
    previewCtx.save();
    previewCtx.translate(size / 2, size / 2);
    if (transform === 'horizontal') previewCtx.scale(-1, 1);
    else if (transform === 'vertical') previewCtx.scale(1, -1);
    else previewCtx.rotate(Number(transform) * Math.PI / 180);
    previewCtx.drawImage(editor, -size / 2, -size / 2);
    previewCtx.restore();
  }
  function queuePreview() {
    if (frame === null) frame = requestAnimationFrame(updatePreview);
  }
  function refreshHistory() {
    $('#undo').disabled = historyIndex === 0;
    $('#redo').disabled = historyIndex === history.length - 1;
    $('#empty-hint').hidden = historyIndex > 0 || dirty;
  }
  function commit() {
    history.splice(historyIndex + 1);
    history.push(ctx.getImageData(0, 0, size, size));
    if (history.length > historyLimit + 1) history.shift();
    historyIndex = history.length - 1;
    dirty = true;
    refreshHistory();
    queuePreview();
  }
  function restore(offset) {
    finishStroke();
    const next = historyIndex + offset;
    if (next < 0 || next >= history.length) return;
    historyIndex = next;
    ctx.putImageData(history[historyIndex], 0, 0);
    dirty = history[historyIndex] !== initialState;
    refreshHistory();
    queuePreview();
    announce(offset < 0 ? '元に戻しました' : 'やり直しました');
  }
  function point(event) {
    const rect = editor.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * size / rect.width,
      y: (event.clientY - rect.top) * size / rect.height,
      width: widths[tool] * (event.pointerType === 'pen' ? 0.45 + 0.85 * (event.pressure || 0.5) : 1) };
  }
  function configureStroke(width) {
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }
  // Brush samples are rendered as overlapping round dabs along quadratic curves.
  // Keep this stroke separate so its tail can taper without erasing earlier work.
  function brushDab(x, y, width) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.08, width / 2), 0, Math.PI * 2);
    ctx.fill();
  }
  function brushCurve(start, control, end) {
    const length = Math.hypot(control.x - start.x, control.y - start.y)
      + Math.hypot(end.x - control.x, end.y - control.y);
    const spacing = Math.max(0.2, Math.min(1.5, Math.min(start.width, end.width) * 0.15));
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * start.x + 2 * u * t * control.x + t * t * end.x;
      const y = u * u * start.y + 2 * u * t * control.y + t * t * end.y;
      const previous = brushStroke.dabs[brushStroke.dabs.length - 1];
      brushStroke.length += Math.hypot(x - previous.x, y - previous.y);
      const width = start.width + (end.width - start.width) * t;
      brushStroke.dabs.push({ x, y, width, distance: brushStroke.length });
      brushDab(x, y, width);
    }
  }
  function moveBrush(event) {
    const current = point(event);
    const distance = Math.hypot(current.x - lastPoint.x, current.y - lastPoint.y);
    // A stationary release often reports pressure=0: don't turn it into a new blob.
    if (distance < 0.01) return;
    const time = Number.isFinite(event.timeStamp) ? event.timeStamp : brushStroke.time + 16;
    const elapsed = Math.max(1, time - brushStroke.time);
    const speed = distance * editor.getBoundingClientRect().width / size / elapsed;
    const speedBlend = 1 - Math.exp(-elapsed / 35);
    brushStroke.speed += (speed - brushStroke.speed) * speedBlend;
    const pressure = event.pointerType === 'pen' && event.pressure > 0
      ? 0.75 + 0.5 * event.pressure : 1;
    const target = brushStroke.base * (0.10 + 1.22 / (1 + Math.pow(brushStroke.speed * 2.4, 1.35))) * pressure;
    // Time-based smoothing behaves consistently with coalesced pen events too.
    brushStroke.width += (target - brushStroke.width) * (1 - Math.exp(-elapsed / 38));
    brushStroke.travel += distance;
    const entry = 0.12 + 0.88 * (1 - Math.exp(-brushStroke.travel / (brushStroke.base * 0.22)));
    // Tiny gestures stay compact even if the pointer pauses or pressure is high.
    current.width = Math.min(brushStroke.width * entry,
      brushStroke.base * 0.12 + brushStroke.travel * 1.15);
    const midpoint = { x: (lastPoint.x + current.x) / 2,
      y: (lastPoint.y + current.y) / 2, width: (lastPoint.width + current.width) / 2 };
    brushCurve(lastMidpoint, lastPoint, midpoint);
    lastPoint = current;
    lastMidpoint = midpoint;
    brushStroke.time = time;
  }
  function finishBrush(taper, releaseTime) {
    brushCurve(lastMidpoint, lastPoint, lastPoint);
    // Replay only the active stroke over its original bitmap. This also preserves
    // colors and overlapping strokes beneath the thin finishing flourish.
    if (taper && brushStroke.length > brushStroke.base * 0.12) {
      ctx.putImageData(history[historyIndex], 0, 0);
      // A quick lift creates a longer, sharper exit; a held stop stays fuller.
      // Follow the actual path rather than inventing an extension past the cursor.
      const pause = Number.isFinite(releaseTime) ? Math.max(0, releaseTime - brushStroke.time) : 0;
      const exitSpeed = brushStroke.speed * Math.exp(-pause / 100);
      const flick = exitSpeed / (exitSpeed + 0.65);
      const tailLength = Math.min(brushStroke.base * (0.9 + 2.4 * flick),
        brushStroke.length * (0.24 + 0.16 * flick));
      const tip = 0.09 - 0.075 * flick;
      for (const dab of brushStroke.dabs) {
        const remaining = brushStroke.length - dab.distance;
        const t = Math.min(1, remaining / tailLength);
        const taperWidth = tip + (1 - tip) * t * t * (3 - 2 * t);
        brushDab(dab.x, dab.y, dab.width * taperWidth);
      }
    }
    brushStroke = null;
  }
  function moveStroke(event) {
    if (brushStroke) { moveBrush(event); return; }
    const current = point(event);
    const midpoint = { x: (lastPoint.x + current.x) / 2, y: (lastPoint.y + current.y) / 2 };
    configureStroke((lastPoint.width + current.width) / 2);
    ctx.beginPath();
    ctx.moveTo(lastMidpoint.x, lastMidpoint.y);
    ctx.quadraticCurveTo(lastPoint.x, lastPoint.y, midpoint.x, midpoint.y);
    ctx.stroke();
    lastPoint = current;
    lastMidpoint = midpoint;
  }
  function finishStroke(event) {
    if (activePointer === null || (event && event.pointerId !== activePointer)) return;
    if (event && event.type === 'pointerup') moveStroke(event);
    if (brushStroke) {
      finishBrush(event?.type === 'pointerup', event?.timeStamp);
    } else {
      configureStroke(lastPoint.width);
      ctx.beginPath();
      ctx.moveTo(lastMidpoint.x, lastMidpoint.y);
      ctx.lineTo(lastPoint.x, lastPoint.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    const pointer = activePointer;
    activePointer = null;
    if (editor.hasPointerCapture(pointer)) editor.releasePointerCapture(pointer);
    commit();
  }
  editor.addEventListener('pointerdown', (event) => {
    if (activePointer !== null || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    activePointer = event.pointerId;
    editor.setPointerCapture(activePointer);
    lastPoint = point(event);
    if (tool === 'brush') {
      lastPoint.width = widths.brush * 0.12;
      brushStroke = { base: widths.brush, width: widths.brush, speed: 0,
        time: Number.isFinite(event.timeStamp) ? event.timeStamp : 0,
        travel: 0, length: 0,
        dabs: [{ x: lastPoint.x, y: lastPoint.y, width: lastPoint.width, distance: 0 }] };
    }
    lastMidpoint = lastPoint;
    configureStroke(lastPoint.width);
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, lastPoint.width / 2, 0, Math.PI * 2);
    ctx.fill();
    dirty = true;
    $('#empty-hint').hidden = true;
    queuePreview();
  });
  editor.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activePointer) return;
    event.preventDefault();
    const events = event.getCoalescedEvents?.();
    for (const sample of events?.length ? events : [event]) moveStroke(sample);
    queuePreview();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) editor.addEventListener(name, finishStroke);
  window.addEventListener('blur', () => finishStroke());
  function updateWidth() {
    const [min, max] = widthRanges[tool];
    $('#width').min = min;
    $('#width').max = max;
    $('#width').value = widths[tool];
    $('#width').setAttribute('aria-label', `${toolNames[tool]}の太さ`);
    $('#width-value').value = widths[tool];
    const dot = $('#width-dot');
    // Keep the eraser indicator inside the existing toolbar at larger sizes.
    const dotSize = tool === 'eraser'
      ? 14 + 14 * (widths[tool] - min) / (max - min)
      : Math.max(3, widths[tool] * 0.35);
    dot.style.width = dot.style.height = `${dotSize}px`;
    dot.style.background = tool === 'eraser' ? '#ccc8dd' : color;
  }
  document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => {
    finishStroke();
    tool = button.dataset.tool;
    document.querySelectorAll('[data-tool]').forEach((item) => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    updateWidth();
  }));
  $('#width').addEventListener('input', (event) => { widths[tool] = Number(event.target.value); updateWidth(); });
  function setColor(value) {
    finishStroke();
    color = value;
    $('#color').value = value;
    document.querySelectorAll('[data-color]').forEach((button) => {
      button.classList.toggle('selected', button.dataset.color === color);
      button.setAttribute('aria-pressed', String(button.dataset.color === color));
    });
    updateWidth();
  }
  document.querySelectorAll('[data-color]').forEach((button) => button.addEventListener('click', () => setColor(button.dataset.color)));
  $('#color').addEventListener('input', (event) => setColor(event.target.value));
  document.querySelectorAll('[data-transform]').forEach((button) => button.addEventListener('click', () => {
    transform = button.dataset.transform;
    document.querySelectorAll('[data-transform]').forEach((item) => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    $('#transform-badge').textContent = button.textContent;
    preview.setAttribute('aria-label', `${button.querySelector('span').textContent}したプレビュー。ここには描画できません。`);
    queuePreview();
  }));
  $('#apply-transform').addEventListener('click', () => {
    finishStroke();
    // Render synchronously so a just-selected transform is always applied.
    if (frame !== null) cancelAnimationFrame(frame);
    updatePreview();
    const transformed = previewCtx.getImageData(0, 0, size, size);
    ctx.putImageData(transformed, 0, 0);
    commit();
    announce('変換した向きから編集できます');
  });
  $('#undo').addEventListener('click', () => restore(-1));
  $('#redo').addEventListener('click', () => restore(1));
  $('#clear').addEventListener('click', () => {
    finishStroke();
    ctx.clearRect(0, 0, size, size);
    commit();
    announce('全消去しました。元に戻すボタンで復元できます');
  });
  $('#save').addEventListener('click', () => {
    finishStroke();
    const output = document.createElement('canvas');
    output.width = output.height = size;
    const outputCtx = output.getContext('2d');
    outputCtx.fillStyle = '#ffffff';
    outputCtx.fillRect(0, 0, size, size);
    outputCtx.drawImage(editor, 0, 0);
    output.toBlob((blob) => {
      if (!blob) { announce('画像を保存できませんでした。もう一度お試しください'); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ambigram-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      announce('白背景のPNG画像を作成しました');
    }, 'image/png');
  });
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea, select') || event.target.isContentEditable) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault();
      restore(event.shiftKey ? 1 : -1);
    } else if (event.key.toLowerCase() === 'y') {
      event.preventDefault();
      restore(1);
    }
  });
  updateWidth();
  updatePreview();
})();

// Record one visit per page load without waiting for the response or retrying.
try {
  fetch('https://script.google.com/macros/s/AKfycbxssCIHsD-N97SHxNC_GN0ihYeC0qy-lb-EY0KmSs6Gnztaph1sITMerLVEnNWOGkYc/exec?app=coin-paradox', {
    method: 'GET',
    mode: 'no-cors',
    cache: 'no-store',
    credentials: 'omit',
    keepalive: true,
  }).catch(() => {});
} catch {
  // Access logging must never interrupt the drawing app.
}
