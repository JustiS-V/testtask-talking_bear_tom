import { TalkingTomColors, TalkingTomSizes } from "@/constants/theme";

describe("TalkingTom theme", () => {
  it("exposes stable screen colors", () => {
    expect(TalkingTomColors.screenBackground).toBe("#0f1116");
    expect(TalkingTomColors.primaryText).toBe("#f2f4f7");
  });

  it("defines layout tokens", () => {
    expect(TalkingTomSizes.horizontalPadding).toBe(20);
    expect(TalkingTomSizes.characterMaxWidth).toBe(460);
  });
});
