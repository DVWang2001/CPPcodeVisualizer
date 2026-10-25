import React from "react";

/**
 * 工具列圖示。教學頁（/tutorial）用跟頁面風格一致的線條 SVG；其他頁維持原本的
 * Glyphicons 字型圖示，不改變正式 IDE 的外觀。
 */
const PATHS: Record<string, string> = {
  repeat: "M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4",
  play: "M7 4l13 8-13 8z",
  pause: "M8 5v14M16 5v14",
  next: "M5 5v14M10 12h10M16 8l4 4-4 4",
  stepin: "M12 4v12M7 11l5 5 5-5M6 20h12",
  stepout: "M12 20V8M7 13l5-5 5 5M6 4h12",
  edit: "M4 20l4-1 11-11-3-3L5 16z",
  auto: "M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0M10 8l6 4-6 4z",
  headphones: "M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zM17 14h3v6h-3z",
  volume: "M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6",
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  gear: "M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2",
  menu: "M4 7h16M4 12h16M4 17h16",
};

export const isTutorial = (): boolean => !!(window as any).initial_data?.tutorial;

export default function ToolIcon({ name, glyph, style }: { name: string; glyph: string; style?: React.CSSProperties }) {
  if (!isTutorial()) return <span className={"glyphicon glyphicon-" + glyph} style={style} />;
  return (
    <svg className="tut-ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name] || ""} />
    </svg>
  );
}
