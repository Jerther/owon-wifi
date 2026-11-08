import {
  EXT, SAMPLING_RATES, clip, formatSi, fullScaleVolts, levelDivAtScreen, offsetAtScreen, positionAtScreen, samplingFor,
  timeRangeSeconds, voltsPerDivision,
} from '../../scope_logic.js';
import { Component, onMounted, onWillUnmount, toRaw, useRef, useState } from '../../core/owl.js';
import { cursorAxes, getPath } from '../../core/store.js';
import { GridPainter } from './grid_painter.js';
import { TracePainter } from './screen_painters.js';
import { composeSnapshot, snapshotLines } from './screen_snapshot.js';
import { TimebaseGestures } from './timebase_gestures.js';

// The scope screen: grid and trace canvases, drag handles, V/T cursors and time base gestures.
export class ScopeScreen extends Component {
  static template = 'owon.ScopeScreen';
  static DRAG_PUSH_MS = 50;
  static DOUBLE_TAP_MS = 350;
  static CURSOR_GRAB_PX = 24;
  static FFT_REPORT_MS = 250;
  static HANDLES = [
    { kind: 'level', index: 0 },
    { kind: 'position', index: 0 },
    { kind: 'offset', index: 0 },
    { kind: 'offset', index: 1 },
  ];

  setup() {
    this.store = useState(this.env.store);
    // drag: the handle being dragged, { kind, index, moved, readout, grab }.
    this.state = useState({ drag: null, activeChannel: 0 });
    this.screenRef = useRef('screen');
    this.gridRef = useRef('grid');
    this.traceRef = useRef('trace');
    this.cursorDrag = null;
    this.lastTap = null;
    this.frameRequest = 0;
    this.gridKey = '';
    this.lastFftReport = 0;
    this.gestures = new TimebaseGestures((steps) => this.stepTimebase(steps), () => this.isDragging);
    this.listeners = [
      ['wheel', (event) => this.gestures.onWheel(event)],
      ['touchstart', (event) => this.gestures.trackPinch(event)],
      ['touchmove', (event) => this.gestures.onTouchMove(event)],
      ['touchend', (event) => this.gestures.trackPinch(event)],
      ['touchcancel', (event) => this.gestures.trackPinch(event)],
    ];
    onMounted(() => this.start());
    onWillUnmount(() => this.stop());
  }

  start() {
    const screen = this.screenRef.el;
    this.gridPainter = new GridPainter(this.gridRef.el);
    this.tracePainter = new TracePainter(this.traceRef.el, this.env.store, this.env.session);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.traceRef.el);
    this.listeners.forEach(([type, listener]) => screen.addEventListener(type, listener, { passive: false }));
    this.frameRequest = requestAnimationFrame((now) => this.onFrame(now));
    this.env.session.screen = this;
  }

  stop() {
    this.env.session.screen = null;
    const screen = this.screenRef.el;
    cancelAnimationFrame(this.frameRequest);
    this.resizeObserver.disconnect();
    this.listeners.forEach(([type, listener]) => screen.removeEventListener(type, listener, { passive: false }));
    this.env.session.status.fft = null;
  }

  // ------------------------------------------------------------ drawing

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const trace = this.traceRef.el;
    const width = Math.round(trace.clientWidth * ratio);
    const height = Math.round(trace.clientHeight * ratio);
    [this.gridRef.el, trace].forEach((canvas) => {
      canvas.width = width;
      canvas.height = height;
    });
    this.gridPainter.ratio = ratio;
    this.tracePainter.ratio = ratio;
    this.gridKey = '';
    this.env.session.markDirty();
  }

  onFrame(now) {
    const session = this.env.session;
    const tookFrame = session.takeFrame();
    const gridChanged = this.refreshGrid();
    if (tookFrame || gridChanged || session.dirty) {
      session.dirty = false;
      this.tracePainter.draw(this.guideChannel);
    }
    this.reportFft(now);
    this.frameRequest = requestAnimationFrame((time) => this.onFrame(time));
  }

  // True when the grid was redrawn, so the axis labels follow its brightness.
  refreshGrid() {
    const brightness = this.env.store.display.gridBrightness;
    const canvas = this.gridRef.el;
    const key = `${canvas.width}x${canvas.height}@${brightness}`;
    const changed = key !== this.gridKey;
    if (changed) {
      this.gridKey = key;
      this.gridPainter.draw(brightness);
    }
    return changed;
  }

  // Channel whose offset is being dragged, or null; read raw so the loop does not subscribe to the state.
  get guideChannel() {
    const drag = toRaw(this.state).drag;
    const isOffset = drag !== null && drag.kind === 'offset';
    return isOffset ? drag.index : null;
  }

  reportFft(now) {
    const status = this.env.session.status;
    const inFft = this.env.store.ui.view === 'fft';
    if (inFft && now - this.lastFftReport >= ScopeScreen.FFT_REPORT_MS) {
      this.lastFftReport = now;
      status.fft = this.tracePainter.spectrum.summary();
    } else if (!inFft && status.fft !== null) {
      status.fft = null;
    }
  }

  snapshot() {
    const lines = snapshotLines(this.env.store, this.env.session.status);
    return composeSnapshot([this.gridRef.el, this.traceRef.el], lines, this.tracePainter.ratio);
  }

  // ------------------------------------------------------------ time base gestures

  get isDragging() {
    return this.cursorDrag !== null || toRaw(this.state).drag !== null;
  }

  stepTimebase(steps) {
    this.env.session.step('settings.rateIndex', steps, SAMPLING_RATES.length);
  }

  // ------------------------------------------------------------ template data

  get cursorsActive() {
    const axes = cursorAxes(this.store.ui);
    return axes.vertical || axes.horizontal;
  }

  get handles() {
    return ScopeScreen.HANDLES.map(({ kind, index }) => ({
      key: `${kind}${index}`,
      kind,
      index,
      hidden: !this.isHandleVisible(kind, index),
      active: kind === 'offset' && index === this.state.activeChannel,
      style: `--at: ${this.handleFraction(kind, index)}`,
    }));
  }

  get readout() {
    const drag = this.state.drag;
    let readout = null;
    if (drag !== null && drag.readout) {
      readout = {
        kind: drag.kind,
        text: this.readoutText(drag),
        style: `--at: ${this.handleFraction(drag.kind, drag.index)}`,
      };
    }
    return readout;
  }

  // Position of a handle as a fraction of the plot: from the left for the trigger position, else from the top.
  handleFraction(kind, index) {
    const { channels, trigger } = this.store.settings;
    let fraction = 0.5 - channels[index].offset;
    if (kind === 'level') {
      fraction = clip(0.5 - channels[trigger.source].offset - trigger.levelDiv / 10, 0, 1);
    } else if (kind === 'position') {
      fraction = trigger.position;
    }
    return fraction;
  }

  isHandleVisible(kind, index) {
    const settings = this.store.settings;
    let visible = this.store.ui.view === 'time';
    if (kind === 'level') {
      visible = visible && settings.trigger.source !== EXT;
    } else if (kind === 'position') {
      visible = visible && !samplingFor(settings.rateIndex).roll;
    } else {
      visible = visible && settings.channels[index].on;
    }
    return visible;
  }

  readoutText(drag) {
    const settings = this.store.settings;
    const channel = settings.channels[drag.kind === 'level' ? settings.trigger.source : drag.index];
    let text = `CH${drag.index + 1} ${formatSi(channel.offset * fullScaleVolts(channel), 'V')}`;
    if (drag.kind === 'level') {
      text = `Trigger ${formatSi(settings.trigger.levelDiv * voltsPerDivision(channel), 'V')}`;
    } else if (drag.kind === 'position') {
      const fromCentre = (settings.trigger.position - 0.5) * timeRangeSeconds(settings.rateIndex);
      text = `Trigger ${formatSi(fromCentre, 's')} from centre`;
    }
    return text;
  }

  // ------------------------------------------------------------ pointer positions

  pointerPosition(event) {
    const rect = this.traceRef.el.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
  }

  pointerFraction(event, kind) {
    const position = this.pointerPosition(event);
    return kind === 'position' ? position.x / position.width : position.y / position.height;
  }

  // ------------------------------------------------------------ handle dragging

  static dragPath(drag) {
    const paths = {
      level: 'settings.trigger.levelDiv',
      position: 'settings.trigger.position',
      offset: `settings.channels.${drag.index}.offset`,
    };
    return paths[drag.kind];
  }

  dragValue(drag, fraction) {
    const settings = this.store.settings;
    let value = offsetAtScreen(fraction);
    if (drag.kind === 'level') {
      value = levelDivAtScreen(fraction, settings.channels[settings.trigger.source].offset);
    } else if (drag.kind === 'position') {
      value = positionAtScreen(fraction);
    }
    return value;
  }

  onHandleDown(event) {
    if (this.state.drag === null) {
      const element = event.currentTarget;
      const kind = element.dataset.kind;
      const index = Number(element.dataset.index);
      element.setPointerCapture(event.pointerId);
      if (kind === 'offset') {
        this.state.activeChannel = index;
      }
      const grab = this.pointerFraction(event, kind) - this.handleFraction(kind, index);
      this.state.drag = { kind, index, moved: false, readout: false, grab };
      event.preventDefault();
    }
  }

  onHandleMove(event) {
    const drag = this.state.drag;
    if (drag !== null) {
      const path = ScopeScreen.dragPath(drag);
      const value = this.dragValue(drag, this.pointerFraction(event, drag.kind) - drag.grab);
      if (value !== getPath(this.env.store, path)) {
        drag.moved = true;
        this.env.session.set(path, value, ScopeScreen.DRAG_PUSH_MS);
      }
      drag.readout = true;
    }
  }

  onHandleUp() {
    const drag = this.state.drag;
    if (drag !== null) {
      this.state.drag = null;
      if (drag.moved) {
        this.env.session.commit(ScopeScreen.dragPath(drag));
      } else {
        this.onHandleTap(drag);
      }
      this.env.session.markDirty();
    }
  }

  // A double tap is the bench scope's "push the knob": the trigger level goes to 50 % of the signal, the others to centre.
  onHandleTap(drag) {
    const now = performance.now();
    const last = this.lastTap;
    const sameHandle = last !== null && last.kind === drag.kind && last.index === drag.index;
    const isDouble = sameHandle && now - last.at < ScopeScreen.DOUBLE_TAP_MS;
    if (isDouble && drag.kind === 'level') {
      this.env.session.setLevelToMiddle();
    } else if (isDouble) {
      this.env.session.set(ScopeScreen.dragPath(drag), drag.kind === 'position' ? 0.5 : 0);
    }
    this.lastTap = isDouble ? null : { kind: drag.kind, index: drag.index, at: now };
  }

  // ------------------------------------------------------------ cursor dragging

  cursorCandidates(position) {
    const ui = this.env.store.ui;
    const axes = cursorAxes(ui);
    const candidates = [];
    if (axes.vertical) {
      ui.vCursors.forEach((fraction, index) => {
        const distance = Math.abs(position.height * (1 - fraction) - position.y);
        candidates.push({ list: 'vCursors', index, horizontal: false, distance });
      });
    }
    if (axes.horizontal) {
      ui.tCursors.forEach((fraction, index) => {
        const distance = Math.abs(position.width * fraction - position.x);
        candidates.push({ list: 'tCursors', index, horizontal: true, distance });
      });
    }
    return candidates;
  }

  nearestCursor(position) {
    let best = null;
    let bestDistance = ScopeScreen.CURSOR_GRAB_PX;
    this.cursorCandidates(position).forEach((candidate) => {
      if (candidate.distance < bestDistance) {
        best = candidate;
        bestDistance = candidate.distance;
      }
    });
    return best;
  }

  onTracePointerDown(event) {
    this.cursorDrag = this.nearestCursor(this.pointerPosition(event));
    if (this.cursorDrag !== null) {
      this.traceRef.el.setPointerCapture(event.pointerId);
    }
  }

  onTracePointerMove(event) {
    const drag = this.cursorDrag;
    const position = this.pointerPosition(event);
    if (drag !== null) {
      const fraction = drag.horizontal ? position.x / position.width : 1 - position.y / position.height;
      this.env.session.set(`ui.${drag.list}.${drag.index}`, clip(fraction, 0, 1));
    } else {
      this.showGrabCursor(this.nearestCursor(position));
    }
  }

  // A resize pointer over a V or T cursor shows that it can be dragged.
  showGrabCursor(cursor) {
    let pointer = '';
    if (cursor !== null) {
      pointer = cursor.horizontal ? 'ew-resize' : 'ns-resize';
    }
    this.traceRef.el.style.cursor = pointer;
  }

  onTracePointerUp() {
    this.cursorDrag = null;
  }
}
