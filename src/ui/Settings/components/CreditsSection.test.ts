import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// react-i18next has no initialized instance in the node test env (i18n.ts
// touches localStorage at import time), so we stub useTranslation to return
// the defaultValue passed to t(). This keeps the test focused on the links.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

// Never touch the real Tauri bridge in a unit test.
const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrl(url),
}));

const showErrorToast = vi.fn();
vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: (msg: string) => showErrorToast(msg),
}));

import { CreditsSection, TELEGRAM_URL, GITHUB_URL } from "./CreditsSection";

describe("CreditsSection", () => {
  it("renders without throwing", () => {
    expect(() => renderToStaticMarkup(createElement(CreditsSection))).not.toThrow();
  });

  it("renders exactly two links", () => {
    const html = renderToStaticMarkup(createElement(CreditsSection));
    const anchors = html.match(/<a[\s>]/g) || [];
    expect(anchors.length).toBe(2);
  });

  it("exposes the correct Telegram and Github URLs as constants", () => {
    expect(TELEGRAM_URL).toBe("https://t.me/nguyen_tan_an");
    expect(GITHUB_URL).toBe("https://github.com/auhsuai/drplay");
  });

  it("renders anchors pointing to the correct hrefs", () => {
    const html = renderToStaticMarkup(createElement(CreditsSection));
    expect(html).toContain('href="https://t.me/nguyen_tan_an"');
    expect(html).toContain('href="https://github.com/auhsuai/drplay"');
  });
});
