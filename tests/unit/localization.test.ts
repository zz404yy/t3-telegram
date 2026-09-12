import { describe, expect, it } from "vitest";
import { CONTROL_MENU_KEYS, detectLocale, MENUS, menuLabels } from "@t3-vibe/frontend-telegram";

describe("Telegram localization", () => {
  it("detects Chinese variants and defaults other clients to English", () => {
    expect(detectLocale("zh-hans")).toBe("zh");
    expect(detectLocale("zh-CN")).toBe("zh");
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale()).toBe("en");
  });

  it("recognizes both languages for every control menu action", () => {
    for (const key of CONTROL_MENU_KEYS) {
      expect(menuLabels(key)).toEqual([MENUS.zh[key], MENUS.en[key]]);
    }
  });
});
