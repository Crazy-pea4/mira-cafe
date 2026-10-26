export type FaceFrame = { blink: boolean; mouth: boolean };
export class FacialAnimation {
  private frame: FaceFrame = { blink: false, mouth: false };
  private blinkTimer?: ReturnType<typeof setTimeout>;
  private mouthTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;
  constructor(
    private update: (frame: FaceFrame) => void,
    private reducedMotion = false,
  ) {
    if (!reducedMotion) this.blinkTimer = setTimeout(() => this.blink(), 4200);
  }
  private emit(patch: Partial<FaceFrame>) {
    if (this.disposed) return;
    this.frame = { ...this.frame, ...patch };
    this.update(this.frame);
  }
  private blink() {
    this.emit({ blink: true });
    this.blinkTimer = setTimeout(() => {
      this.emit({ blink: false });
      this.blinkTimer = setTimeout(() => this.blink(), 4200);
    }, 130);
  }
  speaking(active: boolean) {
    const token = ++this.generation;
    clearTimeout(this.mouthTimer);
    this.emit({ mouth: false });
    if (!active || this.reducedMotion || this.disposed) return;
    const tick = () => {
      if (this.disposed || token !== this.generation) return;
      this.emit({ mouth: !this.frame.mouth });
      this.mouthTimer = setTimeout(tick, this.frame.mouth ? 180 : 120);
    };
    tick();
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.blinkTimer);
    clearTimeout(this.mouthTimer);
  }
}
