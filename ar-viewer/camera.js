/**
 * ar-viewer/camera.js
 * カメラ映像の取得とフレームキャプチャ。
 * - 映像はステージ背景の <video> に流し、アバターを重ねる（簡易WebAR表現）
 * - captureFrame() は現在のフレームを JPEG の base64 で返す（Gemini 送信用）
 * 長辺 1024px に縮小して送る。以前は「幅1280px」基準で、縦長映像だと
 * 巨大な画像になり送信が遅かったため、長辺基準に変えた（2026-11-17）。
 */
const MAX_FRAME_EDGE = 1024;

export class CameraManager {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.captureCanvas = document.createElement('canvas');
  }

  get isRunning() {
    return this.stream !== null;
  }

  async start() {
    if (this.stream) return;
    // 解像度を固定する。facingMode だけだとブラウザが毎回自由に解像度を選び、
    // 初回と「カメラ入」2回目で縦横比が変わることがある。映像は object-fit: cover で
    // 全面表示するため、縦横比が変わると切り取られ方＝画角まで変わってしまう
    // （2026-11-18 実機報告）。ideal 指定なので対応できない端末では近い解像度に落ちる。
    // 縦横比は縦長 3:4 にする。横長 16:9 だと縦長画面への cover 表示で左右が
    // 大きく切り取られ、画角が狭く見えるため（2026-11-18 実機報告・画角統一）。
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1440 },
        height: { ideal: 1920 },
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stop() {
    if (!this.stream) return;
    this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** 現在のフレームを { mimeType, data(base64) } で返す。未起動・未準備なら null。 */
  captureFrame() {
    if (!this.stream || this.video.readyState < 2) return null;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;

    const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    this.captureCanvas.width = w;
    this.captureCanvas.height = h;
    const ctx = this.captureCanvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, w, h);

    const dataUrl = this.captureCanvas.toDataURL('image/jpeg', 0.8);
    return { mimeType: 'image/jpeg', data: dataUrl.split(',')[1] };
  }
}
