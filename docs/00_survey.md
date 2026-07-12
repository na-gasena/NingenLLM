# 人間LLM — 技術サーベイ & アーキテクチャ検討

作成日: 2026-07-13
元ネタ: [Qiita「人間LLM」(Syuparn)](https://qiita.com/Syuparn/items/0001f93221d4d7556271)

## 1. 元記事とこのプロジェクトの違い

| | 元記事 (humanllm) | このプロジェクト |
|---|---|---|
| 質問する側 | AIエージェント (Codex 等) | スマホの人間ユーザー |
| インターフェース | OpenAI API 互換サーバー | ChatGPT ライクなチャット Web アプリ |
| 公開範囲 | localhost のみ | オンライン公開（スマホからアクセス） |
| 追加要件 | — | 途中経過の送信、作業風景のライブ映像配信 |
| 共通点 | 人間が LLM 役。PC 側で返答。WebSocket で双方向通信 | 同じ |

つまり元記事の「人間が応答するサーバー + WebSocket + React UI」という骨格はそのまま使えて、
**(a) インターネット公開、(b) スマホ向けチャット UI、(c) 映像配信** の3つが新規要素。

## 2. 全体アーキテクチャの選択肢

### 案A: 自宅 PC がサーバー + Cloudflare Tunnel で公開（推奨）

```
スマホ(ブラウザ/PWA) ──HTTPS/WSS──> Cloudflare Edge ──Tunnel──> 自宅PC
                                                        ├ Webサーバー(チャットUI配信)
                                                        ├ WebSocketサーバー
                                                        └ オペレーター画面(人間が返答)
```

- **Cloudflare Tunnel**: 無料・帯域無制限。ポート開放/固定IP不要（PC から outbound 接続のみ）。
  HTTPS 証明書自動。WebSocket はデフォルト対応。
  アカウント不要の Quick Tunnel（`trycloudflare.com` のランダム URL）で即試せる。
- 利点: 全部無料、サーバー1プロセスで完結、元記事と同じ思想（PC = 計算資源）。
- 欠点: PC が落ちるとサイトごと落ちる。→ 人間 LLM は「人間が PC 前にいる」前提なので実質問題なし。
- 代替トンネル: ngrok(無料枠は制限強め) / Tailscale Funnel(帯域制限あり) / frp(自前VPS)。

### 案B: クラウド中継 + PC はワーカー接続

- チャット UI と中継サーバーを Vercel / Cloudflare Workers / Fly.io に置き、
  PC 側は outbound WebSocket で「回答ワーカー」として接続。
- 利点: PC オフライン時も「メンテナンス中」を出せる。履歴を DB に永続化しやすい。
- 欠点: デプロイ先が2つに分かれて複雑。無料枠でも WS 常時接続の制約に注意。

### 案C: BaaS (Firebase / Supabase Realtime)

- メッセージングを Firestore / Supabase Realtime に任せ、双方がサブスクライブ。
- 利点: 認証・DB・リアルタイム同期が既製品。サーバー実装ほぼ不要。
- 欠点: ベンダー依存。「トークンストリーミング風」の細かい制御がやや不自由。映像は結局別途。

→ **まず案Aで作り、公開の安定性が欲しくなったら案Bに発展**が現実的。

## 3. チャット部分の技術要件

### 通信プロトコル
- **WebSocket 一本**が最も素直（元記事と同じ）。プロンプト送信・途中経過・
  最終回答・タイピング中継・映像シグナリングまで全部同じコネクションに載せられる。
- 代替: SSE(サーバー→クライアント) + POST(クライアント→サーバー)。CDN 相性は良いが双方向が面倒。

### メッセージプロトコル（独自 or OpenAI 互換）
- **OpenAI API 互換にする案**: 元記事と同様。LibreChat / Open WebUI / Lobe Chat などの
  既存 ChatGPT クローンをフロントにそのまま使える。Vercel AI SDK の `useChat` も接続可能。
- **独自プロトコル案**: 映像・途中経過カード・演出などの独自要素はどうせ拡張になるので、
  自作 UI + 独自 WS メッセージ型のほうが自由度が高い。
- 折衷: フロント実装に Vercel AI SDK の UI Message Stream 形式を採用すると
  `useChat` フックの恩恵（ストリーミング表示・状態管理）を受けつつ独自パートも足せる。

### 「途中経過」の表現（ここが一番面白いところ）
1. **キーストロークストリーミング**: 人間のタイプをそのまま流す。見た目が完全に LLM。
2. **ステータスイベント**: 「🔍 Google で検索中…」「📖 本棚を確認中…」を
   オペレーター画面のボタンで発火 → クライアントに tool-use 風カードで表示。
3. **Reasoning 風表示**: 回答前の「Thinking…」中に人間の独り言を流す
   （ChatGPT の reasoning summary のパロディ）。

### 画面構成（2画面）
- **クライアント画面**（スマホ向け・PWA 化）: ChatGPT ライクなチャット。上部に映像ミニプレイヤー。
- **オペレーター画面**（PC・人間用）: 受信プロンプト一覧、返信エディタ、
  途中経過ボタン群、キーストリーミング ON/OFF、着信通知（音 + OS 通知）。

## 4. 映像配信の選択肢

| 方式 | 遅延 | コスト | 手間 | 備考 |
|---|---|---|---|---|
| YouTube Live (限定公開) 埋め込み | 5〜30秒 | 無料 | 最小 | OBS から配信して iframe 埋め込むだけ |
| [VDO.Ninja](https://vdo.ninja/) | サブ秒 | 無料 | 小 | ブラウザだけで P2P 配信。URL 埋め込みで完結。プロトタイプ最適 |
| WebRTC P2P 自作 (`getDisplayMedia`) | サブ秒 | 無料 | 中 | シグナリングは既存 WS に相乗り。視聴者1〜数人なら十分 |
| MediaMTX 自宅ホスト (WHIP/WHEP) | サブ秒 | 無料 | 中〜大 | OBS→WHIP 入力、ブラウザ WHEP 再生。多機能 |
| Cloudflare Stream Live / Realtime | サブ秒 | 従量課金(Realtime SFU は無料枠あり) | 中 | WHIP/WHEP 標準対応、スケールする |

### 注意点（重要）
- **WebRTC のメディア(UDP)は Cloudflare Tunnel を通らない**。Tunnel が運ぶのは HTTP/WS のみ。
  - P2P 自作の場合: シグナリングは Tunnel 経由の WS で OK。メディアは STUN での直通に賭ける
    （スマホ回線⇔自宅 PC は大抵通るが、CGNAT 環境だと TURN サーバーが必要になる）。
  - TURN が要る場合: Cloudflare Realtime の TURN（無料枠 1TB/月）か coturn 自前ホスト。
  - MediaMTX を自宅ホストする場合も同様に UDP ポートの到達性が課題。
- 遅延を許容できるなら **YouTube Live 限定公開が圧倒的に楽**。「やってる様子」用途なら
  数秒遅延は致命的でない可能性が高い → フェーズ1はこれか VDO.Ninja で十分。

## 5. セキュリティ / 運用

- 公開 URL には**必ず認証**を付ける（人間の画面が配信される・人間の時間が消費されるため）。
  - 手軽: 合言葉 / URL トークン。ちゃんと: Cloudflare Access（無料 50 ユーザー、メール OTP）。
- 配信画面の情報漏洩に注意（OS 通知、パスワード、メール等が映り込む）。配信専用の仮想デスクトップ推奨。
- レート制限: 知人限定なら簡易で OK。「人間は1日20リクエストまで」を仕様兼ネタにできる。

## 6. 演出アイデア（ネタ帳）

- モデル選択メニュー: `ningen-1-mini`（雑だが速い）/ `ningen-1-thinking`（じっくり考える）
- 応答拒否: 「申し訳ありませんが、眠いのでお答えできません」ボタン
- 使用量表示: トークン数の代わりに「疲労度」「消費カロリー」
- Tool use 表示: 「ツール: 冷蔵庫を開ける」「ツール: 母に聞く」
- GPU 使用率パネルの代わりに人間の顔カメラ（真剣度メーター）
- コンテキストウィンドウ: 「直近3件しか覚えていません」

## 7. 推奨スタックと開発フェーズ

**スタック（最小構成）**
- サーバー: Node.js + Hono（or Express）+ ws
- フロント: React + Vite。クライアント画面とオペレーター画面の2エントリ
- 公開: cloudflared（まず Quick Tunnel → 慣れたら独自ドメイン + Access）
- 永続化: 最初はメモリ + JSON ファイル、必要になったら SQLite
- 映像: フェーズ1 = VDO.Ninja or YouTube 埋め込み → フェーズ2 = WebRTC P2P 自作

**フェーズ**
1. **PoC**: ローカルでクライアント⇔オペレーターのチャット往復（WS）
2. **公開**: Quick Tunnel でスマホから実機確認 + 合言葉認証
3. **途中経過**: ステータスイベント + キーストロークストリーミング
4. **映像**: 埋め込みプレイヤー → WebRTC 自作に発展
5. **演出**: モデル選択・tool use 風カード・疲労度表示など

## 参考リンク

- [Qiita: 人間LLM](https://qiita.com/Syuparn/items/0001f93221d4d7556271)
- [Cloudflare Tunnel セットアップ](https://developers.cloudflare.com/tunnel/setup/)
- [Cloudflare Tunnel 2026 解説記事](https://dev.to/recca0120/cloudflare-tunnel-in-2026-expose-localhost-without-opening-ports-or-buying-an-ip-32l5)
- [Cloudflare Stream の WebRTC (WHIP/WHEP)](https://developers.cloudflare.com/stream/webrtc-beta/)
- [Cloudflare ブログ: WHIP/WHEP でサブ秒ライブ配信](https://blog.cloudflare.com/webrtc-whip-whep-cloudflare-stream/)
- [MediaMTX で低遅延スクリーンシェア](https://www.henriaanstoot.nl/2026/04/07/near-zero-latency-webrtc-using-mediamtx-for-screensharing/)
- [VDO.Ninja WHIP/WHEP クライアント](https://vdo.ninja/v26/whip)
