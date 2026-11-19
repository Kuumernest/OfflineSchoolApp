// web/src/pages/gate/CameraScanner.tsx
//
// Reading the card's QR code through the device camera — only where the
// browser can do it on its own.
//
// The BarcodeDetector API ships in Chromium on Android, ChromeOS and macOS and
// is absent elsewhere (Windows and Linux Chrome, Firefox, Safari). Where it is
// missing the button is simply not drawn: a USB scanner in the text field is
// the supported way in, and pulling a QR library into the bundle for a second
// way was judged not worth a dependency.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera, CameraOff } from "lucide-react";

import { Button } from "@/components/ui/Button";

interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorLike { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

const detectorCtor = (): BarcodeDetectorCtor | null =>
  (typeof window !== "undefined" &&
    (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector) || null;

export function CameraScanner({ onDetected }: { onDetected: (value: string) => void }) {
  const { t } = useTranslation();
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const report = useRef(onDetected);
  useEffect(() => { report.current = onDetected; }, [onDetected]);

  // The constructor existing is not enough: some builds expose it with no QR
  // support behind it.
  useEffect(() => {
    const Ctor = detectorCtor();
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) return;
    let live = true;
    Promise.resolve(Ctor.getSupportedFormats?.() ?? ["qr_code"])
      .then((formats) => { if (live) setSupported(formats.includes("qr_code")); })
      .catch(() => { /* unsupported: leave the button out */ });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const Ctor = detectorCtor();
    if (!Ctor) return;
    const detector = new Ctor({ formats: ["qr_code"] });
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let stopped = false;

    const stop = () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };

    const tick = async () => {
      if (stopped || !video.current) return;
      try {
        const found = await detector.detect(video.current);
        const value = found[0]?.rawValue?.trim();
        if (value) {
          // One code, one scan: closing here is what stops a card held in
          // front of the lens from being recorded five times a second.
          stop();
          setOpen(false);
          report.current(value);
          return;
        }
      } catch {
        // A frame that is not ready yet; try the next one.
      }
      timer = window.setTimeout(tick, 250);
    };

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then(async (s) => {
        if (stopped) { s.getTracks().forEach((tr) => tr.stop()); return; }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => undefined);
        }
        void tick();
      })
      .catch(() => {
        setError(t("gatePage.camera.denied"));
        setOpen(false);
      });

    return stop;
  }, [open, t]);

  if (!supported) return null;

  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="secondary"
        icon={open ? <CameraOff className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
        onClick={() => { setError(null); setOpen((o) => !o); }}
      >
        {open ? t("gatePage.camera.stop") : t("gatePage.camera.start")}
      </Button>
      {error && <p className="text-xs text-danger-text" role="alert">{error}</p>}
      {open && (
        <video
          ref={video}
          muted
          playsInline
          aria-label={t("gatePage.camera.preview")}
          className="aspect-video w-full max-w-md rounded-card bg-ink object-cover"
        />
      )}
    </div>
  );
}
