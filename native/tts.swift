// 把文本合成成 16-bit/22.05k 单声道 WAV，并输出「字符 → 音频时刻」标记。
//
// 关键点：AVSpeechSynthesizer 在 write(toBufferCallback:) 过程中仍会回调
// willSpeakRangeOfSpeechString。我们累计已写入的帧数，回调到来时换算成秒，
// 就得到每个发音区间的真实起始时刻——比按字数估算准得多，而且是中文 TTS
// 唯一能在本机拿到的强制对齐信息。
//
// 为什么不直接用 AVAudioFile 写：
// 回调给的 buffer 是 float32（实测 commonFormat = 1、22050Hz、单声道），
// 而 AVAudioFile 的 processingFormat 一旦设成 .pcmFormatInt16，它**不做格式
// 转换**，而是把 float32 的字节按 int16 逐两个搬过去。一个浮点样本被拆成两个
// 整数样本，运放里听起来是一段 52% 过零率的满幅蜂鸣，且文件时长正好翻倍。
// 实测损坏样本长这样：[0, 14988, 0, 14988, 0, 14980 ...]。
// 所以这里自己攒 float 样本、自己做归一化、自己写 WAV 头，全流程可控。

import AVFoundation
import Foundation

let SR = 22050.0

final class Marks: NSObject, AVSpeechSynthesizerDelegate {
    var list: [(Int, Double)] = []
    var frames: Double = 0
    var finished = false

    func speechSynthesizer(_ s: AVSpeechSynthesizer,
                           willSpeakRangeOfSpeechString r: NSRange,
                           utterance: AVSpeechUtterance) {
        list.append((r.location, frames / SR))
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        finished = true
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        finished = true
    }
}

// ---------------------------------------------------------------- 音频工具

/// 从回调 buffer 里取出单声道浮点样本。正常路径是 float32；
/// 万一系统改成 int16，也转成 [-1,1]，免得又出现按字节搬运的事故。
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

/// 线性插值重采样。回调采样率和目标不一致时用，保证时长与 marks 对得上。
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

/// 去直流 + 峰值归一化 + 写 16-bit PCM WAV。
/// 归一化只在峰值偏大时才做：小音量句子保持原样，免得把底噪一起抬起来。
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
    // 留 1dB 余量（0.891 ≈ -1dBFS），保证任何下游整数转换都不会削波
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
    u32(16)          // fmt 块长度
    u16(1)           // PCM
    u16(1)           // 单声道
    u32(rate)        // 采样率
    u32(rate * 2)    // 字节率 = 采样率 × 声道 × 位深/8
    u16(2)           // blockAlign
    u16(16)          // 位深
    h.append(contentsOf: Array("data".utf8))
    u32(UInt32(data.count))

    var file = h
    file.append(data)
    try file.write(to: URL(fileURLWithPath: path))
}

// ---------------------------------------------------------------- 主流程

let args = CommandLine.arguments

if args.count >= 2 && args[1] == "--voices" {
    for v in AVSpeechSynthesisVoice.speechVoices() where v.language.hasPrefix("zh") {
        print("\(v.identifier)\t\(v.name)\t\(v.language)\t\(v.quality.rawValue)")
    }
    exit(0)
}

guard args.count >= 4 else {
    FileHandle.standardError.write("usage: tts <text> <voiceId|auto> <out.wav> [rate] [pitch]\n".data(using: .utf8)!)
    exit(2)
}

let text = args[1]
let wantVoice = args[2]
let outPath = args[3]
// 语速/音高由情绪驱动；不给就用默认值
let rateArg = Float(args.count >= 5 ? (Float(args[4]) ?? 0.48) : 0.48)
let pitchArg = Float(args.count >= 6 ? (Float(args[5]) ?? 1.0) : 1.0)
let outURL = URL(fileURLWithPath: outPath)
try? FileManager.default.removeItem(at: outURL)

let synth = AVSpeechSynthesizer()
let marks = Marks()
synth.delegate = marks

let u = AVSpeechUtterance(string: text)
if wantVoice != "auto", let v = AVSpeechSynthesisVoice(identifier: wantVoice) {
    u.voice = v
} else if let v = AVSpeechSynthesisVoice(language: "zh-CN") {
    u.voice = v
}
u.rate = max(0.3, min(0.62, rateArg))
u.pitchMultiplier = max(0.75, min(1.35, pitchArg))
u.preUtteranceDelay = 0
u.postUtteranceDelay = 0

var samples: [Float] = []
var srcRate = SR

synth.write(u) { buf in
    guard let pcm = buf as? AVAudioPCMBuffer else { return }
    srcRate = pcm.format.sampleRate
    extractSamples(pcm, into: &samples)
    // 按真实比例累计时长：marks 的时刻必须落在最终文件的同一时间轴上
    marks.frames += Double(pcm.frameLength) * (SR / pcm.format.sampleRate)
}

let deadline = Date().addingTimeInterval(30)
while !marks.finished && Date() < deadline {
    RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
}

let resampled = resample(samples, from: srcRate, to: SR)
do {
    try writeWav(resampled, sampleRate: SR, to: outPath)
} catch {
    FileHandle.standardError.write("write failed: \(error)\n".data(using: .utf8)!)
    exit(4)
}

let duration = Double(resampled.count) / SR
var payload: [String: Any] = [
    "duration": (duration * 1000).rounded() / 1000,
    "chars": text.utf16.count,
    "voice": u.voice?.identifier ?? "none",
    "marks": marks.list.map { ["at": $0.0, "t": (($0.1) * 1000).rounded() / 1000] },
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
