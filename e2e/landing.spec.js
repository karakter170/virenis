import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const viewports = [
  { name: "phone-320", width: 320, height: 720 },
  { name: "phone-360", width: 360, height: 800 },
  { name: "phone-375", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 1000 }
];

for (const viewport of viewports) {
  test(`landing page remains usable at ${viewport.name}`, async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Build the team");
    await expect(page.getByRole("banner").getByRole("button", { name: "Build my team" })).toBeVisible();
    const overflow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      body: document.body.scrollWidth
    }));
    expect(overflow.page, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport + 1);
    expect(overflow.body, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport + 1);
    expect(pageErrors).toEqual([]);
  });
}

test("landing page has no automatically detectable serious accessibility violations", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("main")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});

test("primary landing actions and section navigation work by keyboard", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const home = page.getByRole("link", { name: "Virenis home" });
  const howItWorks = page.getByRole("link", { name: "How it works" });
  await home.focus();
  await expect(home).toBeFocused();
  await howItWorks.focus();
  await expect(howItWorks).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#how-it-works$/);
  await expect(page.locator("#how-it-works")).toBeVisible();
});
