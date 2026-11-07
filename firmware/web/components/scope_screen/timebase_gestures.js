// Mouse wheel and two-finger pinch step the time base: wheel up or spreading the fingers zooms in (+1).
export class TimebaseGestures {
  static WHEEL_STEP_PX = 100;
  static PINCH_RATIO = 1.4;

  // onStep(steps) applies the steps; isBusy() is true while a handle or a cursor is dragged.
  constructor(onStep, isBusy) {
    this.onStep = onStep;
    this.isBusy = isBusy;
    this.wheelRemainder = 0;
    this.pinchDistance = 0;
  }

  static distance(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  onWheel(event) {
    const isPixels = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL;
    const steps = isPixels ? this.pixelSteps(event.deltaY) : -Math.sign(event.deltaY);
    event.preventDefault();
    if (steps !== 0) {
      this.onStep(steps);
    }
  }

  // Trackpads send many small deltas: accumulate them so a step needs about WHEEL_STEP_PX.
  pixelSteps(deltaY) {
    const sameDirection = Math.sign(deltaY) === Math.sign(this.wheelRemainder);
    this.wheelRemainder = (sameDirection ? this.wheelRemainder : 0) + deltaY;
    const steps = Math.trunc(this.wheelRemainder / TimebaseGestures.WHEEL_STEP_PX);
    this.wheelRemainder -= steps * TimebaseGestures.WHEEL_STEP_PX;
    return -steps;
  }

  // Called on touchstart and touchend: a pinch exists while exactly two fingers touch.
  trackPinch(event) {
    const isPinch = event.touches.length === 2 && !this.isBusy();
    this.pinchDistance = isPinch ? TimebaseGestures.distance(event.touches) : 0;
    if (isPinch && event.cancelable) {
      event.preventDefault();
    }
  }

  onTouchMove(event) {
    const isPinch = this.pinchDistance > 0 && event.touches.length === 2;
    if (isPinch) {
      event.preventDefault();
      this.stepPinch(TimebaseGestures.distance(event.touches));
    }
  }

  stepPinch(distance) {
    const ratio = distance / this.pinchDistance;
    let steps = 0;
    if (ratio >= TimebaseGestures.PINCH_RATIO) {
      steps = 1;
    } else if (ratio <= 1 / TimebaseGestures.PINCH_RATIO) {
      steps = -1;
    }
    if (steps !== 0) {
      this.pinchDistance = distance;
      this.onStep(steps);
    }
  }
}
