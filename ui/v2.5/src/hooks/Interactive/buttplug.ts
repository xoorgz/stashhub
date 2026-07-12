import { useEffect, useState } from "react";
import {
  ButtplugClient,
  ButtplugBrowserWebsocketClientConnector,
  ButtplugClientDevice,
} from "buttplug";

// buttplug.io / Intiface transport for the feed. Drives any Intiface-supported
// device (Handy, Kiiroo Keon/Powerblow, Lovense, ...) from a funscript, in
// parallel to the Handy-cloud path in interactive.ts. Intiface Central must be
// running locally; the browser connects to its WebSocket server.

export type ButtplugStatus =
  | "disconnected"
  | "connecting"
  | "scanning"
  | "ready"
  | "error";

export interface ButtplugSnapshot {
  status: ButtplugStatus;
  deviceName: string | null;
  error: string | null;
}

interface Action {
  at: number;
  pos: number;
}

export const DEFAULT_INTIFACE_URL = "ws://127.0.0.1:12345";
const CONFIG_KEY = "stashhub.interactive";
export const INTERACTIVE_CONFIG_EVENT = "stashhub:interactive-config-changed";

export interface InteractiveConfig {
  intifaceEnabled: boolean;
  intifaceUrl: string;
}

export const DEFAULT_INTERACTIVE_CONFIG: InteractiveConfig = {
  intifaceEnabled: false,
  intifaceUrl: DEFAULT_INTIFACE_URL,
};

export function loadInteractiveConfig(): InteractiveConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_INTERACTIVE_CONFIG;
    return { ...DEFAULT_INTERACTIVE_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_INTERACTIVE_CONFIG;
  }
}

export function saveInteractiveConfig(c: InteractiveConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
    window.dispatchEvent(new CustomEvent(INTERACTIVE_CONFIG_EVENT));
  } catch {
    /* ignore */
  }
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Min ms between device commands, floors the rate for dense scripts.
const MIN_DISPATCH_MS = 40;
// Max look-ahead used to schedule the next dispatch.
const MAX_DISPATCH_MS = 400;

class ButtplugManager {
  private client: ButtplugClient | null = null;
  private device: ButtplugClientDevice | null = null;

  status: ButtplugStatus = "disconnected";
  deviceName: string | null = null;
  error: string | null = null;
  url = DEFAULT_INTIFACE_URL;

  private videoEl: HTMLVideoElement | null = null;
  private actions: Action[] | null = null;
  private rafId: number | null = null;
  private nextAt = 0;
  private stopped = true;

  private listeners = new Set<() => void>();
  private snap: ButtplugSnapshot = {
    status: "disconnected",
    deviceName: null,
    error: null,
  };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  snapshot(): ButtplugSnapshot {
    return this.snap;
  }

  private emit() {
    this.snap = {
      status: this.status,
      deviceName: this.deviceName,
      error: this.error,
    };
    this.listeners.forEach((f) => f());
  }

  private setStatus(s: ButtplugStatus) {
    this.status = s;
    this.emit();
  }

  async connect(url?: string) {
    if (this.status === "connecting" || this.status === "scanning") return;
    if (url) this.url = url;
    this.error = null;
    this.setStatus("connecting");
    try {
      const client = new ButtplugClient("stashhub feed");
      client.addListener("deviceadded", (d: ButtplugClientDevice) =>
        this.onDeviceAdded(d)
      );
      client.addListener("deviceremoved", () => this.onDeviceRemoved());
      client.addListener("disconnect", () => this.onDisconnect());
      const connector = new ButtplugBrowserWebsocketClientConnector(this.url);
      await client.connect(connector);
      this.client = client;
      const existing = client.devices;
      if (existing.length) {
        this.onDeviceAdded(existing[0]);
      } else {
        this.setStatus("scanning");
        await client.startScanning();
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.client = null;
      this.setStatus("error");
    }
  }

  async disconnect() {
    this.release();
    const c = this.client;
    this.client = null;
    this.device = null;
    this.deviceName = null;
    try {
      await c?.disconnect();
    } catch {
      /* ignore */
    }
    this.setStatus("disconnected");
  }

  private onDeviceAdded(d: ButtplugClientDevice) {
    if (this.device) return; // keep the first device
    this.device = d;
    this.deviceName = d.name;
    this.setStatus("ready");
    this.client?.stopScanning().catch(() => {});
  }

  private onDeviceRemoved() {
    this.device = null;
    this.deviceName = null;
    this.release();
    if (this.client?.connected) {
      this.setStatus("scanning");
      this.client.startScanning().catch(() => {});
    }
  }

  private onDisconnect() {
    this.device = null;
    this.deviceName = null;
    this.client = null;
    this.release();
    this.setStatus("disconnected");
  }

  // Bind a playing video + its funscript. Called on the active tile's `play`.
  bind(videoEl: HTMLVideoElement, actions: Action[]) {
    if (!this.device || !actions.length) return;
    this.videoEl = videoEl;
    this.actions = actions;
    this.nextAt = 0;
    this.stopped = true;
    if (this.rafId == null) {
      this.rafId = requestAnimationFrame(this.loop);
    }
  }

  // Release only if the given element still owns the manager.
  unbind(videoEl: HTMLVideoElement) {
    if (this.videoEl !== videoEl) return;
    this.release();
  }

  private release() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.videoEl = null;
    this.actions = null;
    if (!this.stopped) {
      this.device?.stop().catch(() => {});
      this.stopped = true;
    }
  }

  private loop = (now: number) => {
    this.rafId = requestAnimationFrame(this.loop);
    const v = this.videoEl;
    const actions = this.actions;
    const dev = this.device;
    if (!v || !actions || !dev) return;
    if (v.paused || v.ended) {
      if (!this.stopped) {
        dev.stop().catch(() => {});
        this.stopped = true;
      }
      return;
    }
    this.stopped = false;
    if (now < this.nextAt) return;

    const ms = v.currentTime * 1000;
    // Segment index i: largest with actions[i].at <= ms, or -1 before the first.
    const i = this.findSegment(actions, ms);
    let targetIdx = i + 1;
    if (targetIdx >= actions.length) return; // past the last keyframe
    let target = actions[targetIdx];
    let dur = target.at - ms;
    if (dur <= 0) {
      targetIdx = Math.min(targetIdx + 1, actions.length - 1);
      target = actions[targetIdx];
      dur = Math.max(1, target.at - ms);
    }
    const prev = actions[Math.max(0, targetIdx - 1)];
    this.dispatch(dev, prev, target, dur);
    this.nextAt =
      now + Math.max(MIN_DISPATCH_MS, Math.min(dur, MAX_DISPATCH_MS));
  };

  private dispatch(
    dev: ButtplugClientDevice,
    prev: Action,
    target: Action,
    dur: number
  ) {
    const sendDur = Math.round(Math.max(30, dur));
    if (dev.linearAttributes.length > 0) {
      dev.linear(clamp01(target.pos / 100), sendDur).catch(() => {});
    } else if (dev.oscillateAttributes.length > 0) {
      dev.oscillate(this.strokeSpeed(prev, target)).catch(() => {});
    } else if (dev.vibrateAttributes.length > 0) {
      dev.vibrate(this.strokeSpeed(prev, target)).catch(() => {});
    }
  }

  // Map a stroke (delta pos over delta time) to a 0-1 intensity for
  // non-positional devices (suction, vibration). A full stroke in ~250ms
  // reads as full intensity.
  private strokeSpeed(a: Action, b: Action) {
    const dp = Math.abs(b.pos - a.pos) / 100;
    const dt = Math.max(1, b.at - a.at);
    return clamp01(dp / (dt / 250));
  }

  private findSegment(actions: Action[], ms: number) {
    if (ms < actions[0].at) return -1;
    let lo = 0;
    let hi = actions.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (actions[mid].at <= ms) lo = mid;
      else hi = mid;
    }
    return lo;
  }
}

export const buttplug = new ButtplugManager();

// React binding for connection status.
export function useButtplug(): ButtplugSnapshot {
  const [snap, setSnap] = useState<ButtplugSnapshot>(buttplug.snapshot());
  useEffect(() => buttplug.subscribe(() => setSnap(buttplug.snapshot())), []);
  return snap;
}
