// 常驻合成服务：从 stdin 逐行读请求，把 WAV 与字符时间戳写回 stdout。
//
// 为什么要常驻：单次调用 AVSpeechSynthesizer 的主要开销不在合成，而在
// 进程启动 + 语音加载（实测 0.47~0.65s）。一个词就说一句话的场景，
// 这点延迟会直接压在"按下回车到听见声音"上。常驻后每句只剩合成本身。
//
// WAV 的写法与 tts.swift 一致：自己攒 float 样本、自己写头。
// 原因见 tts.swift 顶部注释——AVAudioFile 在 processingFormat 与回调 buffer
// 格式不一致时不转换，直接按字节搬运，产物是一段满幅蜂鸣。

import AVFoundation
import Foundation

let SR = 22050.0

final class Sink: NSObject, AVSpeechSynthesizerDelegate {
    var marks: [(Int, Double)] = []
    var frames: Double = 0
    var done = false
    func reset() {
        marks.removeAll()
        frames = 0
        done = false
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer,
                           willSpeakRangeOfSpeechString r: NSRange,
                           utterance: AVSpeechUtterance) {
        marks.append((r.location, frames / SR))
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { done = true }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { done = true }
}

// ---------------------------------------------------------------- 音频工具

func extractSamples(_ pcm: AVAudioPCMBuffer, into out: inout [Float]) {
    let n = Int(pcm.frameLength)
    guard n > 0 else { return }
    if let f = pcm.floatChannelData {
        let p = f[0]
        out.reserveCapacity(out.count + n)
        for i in 0..<n { out.append(p[i]) }
    } else if let s = pcm.int16ChannelData {
        let p = s[0]
        out.reserveCapacity(out.count + n)
        for i in 0..<n { out.append(Float(p[i]) / 32768.0) }
    }
}

func resample(_ x: [Float], from: Double, to: Double) -> [Float] {
    guard from > 0, to > 0, abs(from - to) > 1 else { return x }
    let n = Int(Double(x.count) * to / from)
    guard n > 1 else { return x }
    var out = [Float](repeating: 0, count: n)
    for i in 0..<n {
        let pos = Double(i) * from / to
        let i0 = Int(pos)
        let frac = Float(pos - Double(i0))
        let a = x[min(i0, x.count - 1)]
        let b = x[min(i0 + 1, x.count - 1)]
        out[i] = a + (b - a) * frac
    }
    return out
}

func writeWav(_ samples: [Float], sampleRate: Double, to path: String) throws {
    guard !samples.isEmpty else { throw NSError(domain: "tts", code: 1) }

    var sum: Double = 0
    for v in samples { sum += Double(v) }
    let dc = sum / Double(samples.count)

    var peak: Double = 0
    for v in samples {
        let a = abs(Double(v) - dc)
        if a > peak { peak = a }
    }
    let gain = peak > 0.891 ? 0.891 / peak : 1.0

    var ints = [Int16](repeating: 0, count: samples.count)
    for i in 0..<samples.count {
        let v = (Double(samples[i]) - dc) * gain * 32767.0
        ints[i] = Int16(max(-32768.0, min(32767.0, v.rounded())))
    }
    let data = ints.withUnsafeBytes { Data($0) }

    var h = Data(capacity: 44 + data.count)
    func u32(_ v: UInt32) {
        var x = v.littleEndian
        withUnsafeBytes(of: &x) { h.append(contentsOf: $0) }
    }
    func u16(_ v: UInt16) {
        var x = v.littleEndian
        withUnsafeBytes(of: &x) { h.append(contentsOf: $0) }
    }
    let rate = UInt32(sampleRate.rounded())
    h.append(contentsOf: Array("RIFF".utf8))
    u32(UInt32(36 + data.count))
    h.append(contentsOf: Array("WAVE".utf8))
    h.append(contentsOf: Array("fmt ".utf8))
    u32(16)
    u16(1)
    u16(1)
    u32(rate)
    u32(rate * 2)
    u16(2)
    u16(16)
    h.append(contentsOf: Array("data".utf8))
    u32(UInt32(data.count))

    var file = h
    file.append(data)
    try file.write(to: URL(fileURLWithPath: path))
}

// ---------------------------------------------------------------- 主流程

func synthOne(text: String, voice: String, outPath: String, rate: Float, pitch: Float) -> [String: Any] {
    sink.reset()
    try? FileManager.default.removeItem(atPath: outPath)

    let u = AVSpeechUtterance(string: text)
    if voice != "auto", let v = AVSpeechSynthesisVoice(identifier: voice) {
        u.voice = v
    } else if let v = AVSpeechSynthesisVoice(language: "zh-CN") {
        u.voice = v
    }
    // 语速和音高由情绪驱动：低落时慢而低，兴奋时快而扬。
    // 表情和声音如果不在同一个情绪上，脸越生动越假。
    u.rate = max(0.3, min(0.62, rate))
    u.pitchMultiplier = max(0.75, min(1.35, pitch))
    u.preUtteranceDelay = 0
    u.postUtteranceDelay = 0

    var samples: [Float] = []
    var srcRate = SR

    synth.write(u) { buf in
        guard let pcm = buf as? AVAudioPCMBuffer else { return }
        srcRate = pcm.format.sampleRate
        extractSamples(pcm, into: &samples)
        sink.frames += Double(pcm.frameLength) * (SR / pcm.format.sampleRate)
    }

    let deadline = Date().addingTimeInterval(30)
    while !sink.done && Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005))
    }

    let resampled = resample(samples, from: srcRate, to: SR)
    do {
        try writeWav(resampled, sampleRate: SR, to: outPath)
    } catch {
        return ["ok": false, "error": "write: \(error.localizedDescription)"]
    }

    return [
        "ok": true,
        "duration": (Double(resampled.count) / SR * 1000).rounded() / 1000,
        "chars": text.utf16.count,
        "voice": u.voice?.identifier ?? "none",
        "marks": sink.marks.map { ["at": $0.0, "t": ($0.1 * 1000).rounded() / 1000] },
    ]
}

let synth = AVSpeechSynthesizer()
let sink = Sink()
synth.delegate = sink

FileHandle.standardError.write("ready\n".data(using: .utf8)!)

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty else { continue }
    guard let data = line.data(using: .utf8),
          let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let id = req["id"] as? String,
          let text = req["text"] as? String,
          let out = req["out"] as? String
    else {
        print("{\"ok\":false,\"error\":\"bad request\"}")
        fflush(stdout)
        continue
    }
    let voice = (req["voice"] as? String) ?? "auto"
    let rate = (req["rate"] as? Double).map { Float($0) } ?? 0.48
    let pitch = (req["pitch"] as? Double).map { Float($0) } ?? 1.0
    var payload = synthOne(text: text, voice: voice, outPath: out, rate: rate, pitch: pitch)
    payload["id"] = id
    if let d = try? JSONSerialization.data(withJSONObject: payload),
       let s = String(data: d, encoding: .utf8) {
        print(s)
    } else {
        print("{\"ok\":false,\"error\":\"encode\"}")
    }
    fflush(stdout)
}
