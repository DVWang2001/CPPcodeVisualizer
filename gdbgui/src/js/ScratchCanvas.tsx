import * as React from "react";
import { clearStrokes, loadStrokes, saveStrokes, ScratchStroke } from "./scratchStrokes";

type Props = {
  questionKey: string;
  /** 唯讀縮圖：只重畫，不接受輸入。用在填表分頁右上角那個小視窗。 */
  readOnly?: boolean;
  onTap?: () => void;
};

/**
 * 草稿畫布。工具刻意最小——畫、擦、復原、清空。
 *
 * 白紙沒有顏色和粗細可選，多給選項只會讓學生在選工具而不是在想演算法。
 */
export default function ScratchCanvas({ questionKey, readOnly, onTap }: Props) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = React.useState<ScratchStroke[]>(() => loadStrokes(questionKey));
  const [erasing, setErasing] = React.useState(false);
  const drawingRef = React.useRef<ScratchStroke | null>(null);

  // 尺寸變了就照新尺寸重畫。座標是正規化的，所以轉向不會讓線條變形。
  const redraw = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#17233b";
    ctx.lineWidth = readOnly ? 1 : 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      if (stroke.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x * width, stroke[0].y * height);
      for (const point of stroke.slice(1)) ctx.lineTo(point.x * width, point.y * height);
      if (stroke.length === 1) ctx.lineTo(stroke[0].x * width + 0.5, stroke[0].y * height + 0.5);
      ctx.stroke();
    }
  }, [strokes, readOnly]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      redraw();
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [redraw]);

  React.useEffect(redraw, [redraw]);

  const pointAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    };
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (erasing) {
      // 橡皮擦：擦掉被碰到的整條筆畫。局部擦除對手指的精度來說沒有意義。
      const hit = pointAt(event);
      setStrokes(previous => {
        const kept = previous.filter(stroke =>
          !stroke.some(p => Math.abs(p.x - hit.x) < 0.04 && Math.abs(p.y - hit.y) < 0.04)
        );
        saveStrokes(questionKey, kept);
        return kept;
      });
      return;
    }
    drawingRef.current = [pointAt(event)];
    setStrokes(previous => [...previous, drawingRef.current!]);
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly || !drawingRef.current) return;
    drawingRef.current.push(pointAt(event));
    setStrokes(previous => previous.slice());
  };

  const end = () => {
    if (readOnly || !drawingRef.current) return;
    drawingRef.current = null;
    setStrokes(previous => {
      saveStrokes(questionKey, previous);
      return previous;
    });
  };

  const undo = () => setStrokes(previous => {
    const kept = previous.slice(0, -1);
    saveStrokes(questionKey, kept);
    return kept;
  });

  const wipe = () => {
    clearStrokes(questionKey);
    setStrokes([]);
  };

  return (
    <div className={readOnly ? "scratch scratch-mini" : "scratch"} onClick={readOnly ? onTap : undefined}>
      <canvas
        ref={canvasRef}
        className="scratch-surface"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      {!readOnly && (
        <div className="scratch-tools">
          <button type="button" className={erasing ? "" : "on"} onClick={() => setErasing(false)}>畫</button>
          <button type="button" className={erasing ? "on" : ""} onClick={() => setErasing(true)}>擦</button>
          <button type="button" onClick={undo} disabled={strokes.length === 0}>復原</button>
          <button type="button" onClick={wipe} disabled={strokes.length === 0}>清空</button>
        </div>
      )}
    </div>
  );
}
