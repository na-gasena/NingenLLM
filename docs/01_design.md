# 人間LLM — 設計方針（決定事項と詳細検討）

作成日: 2026-07-13
前提: [00_survey.md](00_survey.md) のサーベイ結果を受けた設計フェーズのメモ。

## 0. 決定事項

- **アーキテクチャ**: 案A（自宅PC + Cloudflare Tunnel）で進める。案B（クラウド中継 + PCワーカー）は
  移行先として捨てない（→ §4 移行パス）。
- **メッセージプロトコル**: OpenAI API 互換。フロントは既存 ChatGPT クローンをそのまま使う。
  ユーザー体験は ChatGPT とほぼ同じにする。
- **元記事の構成の位置づけ**: humanllm の「OpenAI互換サーバー + WebSocket + React UI」のうち、
  React UI は**オペレーター（人間）用画面**としてそのまま活きる。スマホ側クライアントは
  ChatGPT クローンが担う。人間は「LLM の席に座る」だけで、クライアントが Codex か
  チャット UI かはサーバーから見て区別がない → この構成で (a)(b)(c) すべて成立する。

## 1. 全体構成（案A 確定版）

```
スマホ(ブラウザ/PWA)
   │ HTTPS/WSS
   ▼
Cloudflare Tunnel（公開するのはチャットUIのみ）
   │
   ▼ 自宅PC
   ├─ ChatGPTクローン (Open WebUI 想定, :8080)   ← スマホが見る画面。認証はここに内蔵
   │      │ OpenAI互換API (chat/completions, stream)
   │      ▼
   ├─ humanllm互換サーバー (:3000)               ← LLMのフリをする窓口
   │      │ WebSocket
   │      ▼
   └─ オペレーター画面 (React, :5173)             ← 人間が返答・途中経過を打つ。ローカルのみ

映像: OBS → YouTube Live(限定公開) ※常時配信。表示のON/OFFはクライアント側で制御(§3)
```

- Tunnel の public hostname は Open WebUI だけに割り当てる。humanllm サーバーと
  オペレーター画面は LAN 内に留める（攻撃面を最小化）。
- Open WebUI はアカウント認証内蔵（サインアップ無効化可）+ PWA 対応
  → 「公開URLの認証」「スマホでアプリっぽく使う」の両要件がフロント選定だけで片付く。

### フロント（ChatGPTクローン）の選定
- **第一候補: Open WebUI** — セルフホスト定番、UI が ChatGPT に近い、PWA、認証内蔵、
  OpenAI 互換エンドポイントを model として登録可能、拡張機構（Pipe/Function）が強力。
- 対抗: LibreChat（マルチプロバイダ強い）、Lobe Chat。いずれも OpenAI 互換接続可なので
  humanllm サーバー側は共通のまま乗り換え可能。

## 2. 「途中経過」の実現方式 — 2レベル戦略

### レベル1: 純 OpenAI 互換のまま（どのクローンでも動く）

ストリーミング応答の中に `<think>...</think>` タグで途中経過を流す。
Open WebUI（や主要クローン）は think タグを**折りたたみ式の「Thinking」ブロック**として表示し、
**回答完了時に自動で畳む**。

```
data: {"choices":[{"delta":{"content":"<think>"}}]}
data: {"choices":[{"delta":{"content":"🔍 Googleで検索中… \n"}}]}
data: {"choices":[{"delta":{"content":"📄 閲覧中: https://example.com/foo \n"}}]}
data: {"choices":[{"delta":{"content":"</think>"}}]}
data: {"choices":[{"delta":{"content":"（ここから最終回答の本文…）"}}]}
```

- 閲覧 URL は think 内に markdown リンクで流せば良い。
- `reasoning_content` フィールド方式（DeepSeek 式）も Open WebUI は解釈するが、
  テキスト埋め込みの think タグ方式のほうがクローン間の互換性が高い。
- オペレーター画面に「検索中」「閲覧中: <URL>」等のボタン/入力欄を置き、
  押すと think ストリームに 1 行流れる、という UX にする。

### レベル2: Open WebUI の Pipe 関数（ChatGPT の Web 検索表示に最接近）

Open WebUI 内に Python の **Pipe 関数**を置き、それが humanllm サーバーと通信する構成。
Pipe は `__event_emitter__` で以下のネイティブ UI イベントを発火できる:

- **`status` イベント**: メッセージ上部に「🔍 Google で検索中…」のステータス行を逐次表示
  （ChatGPT が Web 検索するときの表示とほぼ同じ見た目）
- **`citation` イベント**: 閲覧したサイトを**ソースチップ**（出典カード、URL付き）として
  回答の下に表示 ← 「閲覧しているサイトも見えるようにしたい」の理想形
- `message` / `embeds` / `notification` などのイベント型もある（embeds は §3 の映像表示に
  使えるか要検証）

トレードオフ: Open WebUI 専用になる。→ **humanllm サーバー側のプロトコルはレベル1の
形で完成させ、レベル2の Pipe は「Open WebUI 用アダプタ」として後付け**するのが安全。

## 3. 映像表示の設計

### 要件の整理
- チャット（プロンプト処理）が始まったらクライアントに映像が出る
- プロンプト依頼が完了したら表示が消える
- 安定していること

### 大原則: 「配信」と「表示」を分離する
チャットのたびに配信を開始/停止するのは不安定要素そのもの（YouTube Live は開始に
数十秒〜のラグ、エンコーダ再起動リスク）。なので:

- **配信は稼働時間中ずっと流しっぱなし**（YouTube Live 限定公開。安定性は YouTube CDN 任せで最良）
- **「出る/消える」はクライアント側の表示制御だけで実現する**

### 表示制御の実装案（要件への忠実度順）

| 案 | 内容 | 改造量 | 忠実度 |
|---|---|---|---|
| V1: think ブロック内リンク | 応答冒頭の think 内に「🔴 ライブで見る」リンク（+サムネ画像）を流す。生成中は展開表示 → **完了時に自動で畳まれる = 実質消える** | ゼロ | 中 |
| V2: Pipe の status/embeds イベント | status 行に配信リンクを常掲。`embeds` イベントでプレイヤー埋め込みできるか**要検証** | 小 | 中〜高 |
| V3: Open WebUI 小改造 | 「応答生成中(streaming状態)のときだけ画面上部に YouTube 埋め込みプレイヤーを出す」1コンポーネント追加。OSS(Svelte)なのでフォークは小規模 | 中 | **高（要件そのもの）** |
| V4: 自作フロント | 表示は完全自由だが「既存クローンをそのまま」方針に反する | 大 | 高 |

推奨: **V1 で始めて、要件（自動で出て消える）に忠実にしたければ V3 に進む。**
V3 の改造は「チャットの streaming フラグ」と「プレイヤー表示」を繋ぐだけなので
本体更新への追従コストは小さい。

### 配信方式の補足
- YouTube Live 限定公開: 無料・最安定。低遅延モードで遅延 2〜5 秒。埋め込みは
  `youtube-nocookie.com/embed/<id>` が使える。限定公開は「URL を知っていれば見られる」
  点だけ留意（認証済みチャット UI の中にしか URL を出さなければ実用上問題なし）。
- 将来セルフホスト化する場合: MediaMTX の **LL-HLS は HTTP なので Cloudflare Tunnel を
  通せる**（WebRTC/UDP と違い追加のNAT越え不要、遅延2〜5秒）。ただし無料プランでの
  大量動画配信は Cloudflare の規約グレーなので、視聴者が少人数の個人用途に限る。

## 4. 案B（クラウド中継）への移行パス

OpenAI 互換 + 「APIサーバー ⇔ オペレーター画面は WebSocket」という humanllm の内部構造を
保っておけば、移行は次の置き換えだけで済む:

1. humanllm 互換サーバー（OpenAI 互換の窓口）を Fly.io / Railway 等に移す
2. オペレーター画面（PC側）は**外向き WebSocket** でクラウドの窓口に接続（ワーカー化）
3. Open WebUI もクラウドに置けば、PC オフライン時でも履歴閲覧やログインが可能になり、
   「人間が離席中です」の応答も窓口側で返せる

→ 設計上の約束事: **「窓口とオペレーターの間のメッセージ型」を最初からネットワーク越し
前提で定義しておく**（localhost 前提の密結合にしない）。

## 5. 残課題 / 要検証リスト

- [ ] Open WebUI の think ブロック内で画像/リンクがどう描画されるか実機確認
- [ ] Pipe の `embeds` イベントで iframe(YouTube) を出せるか検証
- [ ] think タグ方式のストリーミングが Open WebUI / LibreChat 両方で意図通り畳まれるか
- [ ] YouTube Live 限定公開の長時間配信運用（配信枠の使い回し、URL固定化 = 「ライブ配信を予約」機能で固定URL可）
- [ ] オペレーター画面から「閲覧中URL」を楽に送る仕組み（ブラウザ拡張でアクティブタブURLを自動送信、など）
- [ ] 複数チャット同時着信時の扱い（人間はシングルスレッド。キューイング + 「順番待ち」応答）
- [ ] **`server/api/chat.ts` の `TIMEOUT_MS`（回答待ちタイムアウト）**: 動作確認時に元の5分から
      暫定で1時間に延長済み（2026-07-13）。本番でどれくらいが適切か要調整
      （長すぎるとpendingリクエストが溜まる、短すぎるとじっくり考える人間LLMに厳しい。
      環境変数化 or リクエストごとに人間が延長できるUIも検討候補）

## 6. 動作確認フェーズで判明したこと（2026-07-13）

- **Fork/Clone構成**: `humanllm/` を `Syuparn/humanllm` からFork（`na-gasena/humanllm`、Public、MIT）
  し、`upstream` リモート設定済み。プロジェクト内 `humanllm/` サブフォルダに配置
  （プロジェクト直下の `docs/` とは独立）。
- **Codex CLIでの動作確認は成功**: `~/.codex/humanllm.config.toml` にプロファイルを作成し、
  `codex --profile humanllm` で疎通確認済み。既存の本番用 `~/.codex/config.toml`（Codexデスクトップアプリ
  の実アカウント設定）には無影響。
  - Cursor拡張は `--profile` 未対応（本番configを直接書き換える必要が出るため）で今回は非採用、
    CLIで確認する方針にした。
- **`/v1/chat/completions` のストリーミング対応を実装済み（2026-07-13）**: 元の
  [server/api/chat.ts](../humanllm/server/api/chat.ts) は `stream` を無視して一括JSONを返すだけで、
  Open WebUI（デフォルトで `stream: true`）から繋ぐと**リクエストは届くが回答が表示されない**
  症状が出た。対応として [server/api/chat-node.ts](../humanllm/server/api/chat-node.ts) を新設し、
  `responses-node.ts` と同じ「Honoを経由せず生ソケットでSSE送信」方式で Chat Completions 形式の
  ストリーミング（`chat.completion.chunk` → `delta.content` → `finish_reason:stop` → `[DONE]`）を実装。
  `stream:false` の場合は従来通り一括JSON。ルーティングは `server/index.ts` で `/v1/chat/completions`
  → `handleChatNode` に振り分け、`chat.ts` は `/v1/models` のみ担当に整理。
  - **検証済み**: WSでオペレーター役を自動化したE2Eテスト（scratchpad/test-chat-stream.mjs）で
    ストリーミング・非ストリーミング両方 PASS。これで Open WebUI のストリーミング設定は
    ON（デフォルト）のままで動く。
  - この生ソケットSSE基盤が `<think>` タグ途中経過表示（§2）実装の土台になる。
- **CORSは全開放**（`app.use('*', cors())`）＋ **`/v1/models` 実装済み**なので、
  ブラウザ完結型のOpenAI互換クライアントからでも接続しやすい。
- **Open WebUIのセットアップ**: Python 3.14 では `pip install open-webui` が**不可**
  （open-webui全バージョンが `Python <3.13` 要求で候補が見つからない）。公式推奨の Python 3.11 を
  `uv` で隔離導入する方式に切替え、`uvx --python 3.11 open-webui@latest serve` で起動成功。
  - `uv` は Python本体を `%APPDATA%\uv\python\` に、パッケージ実体を共有キャッシュ
    `%LOCALAPPDATA%\uv\cache\`（初回で約2.4GB、ML依存が重い）に置き、ツール環境はそこへの
    リンク集として構築（`uvx`環境は使い捨て）。既存の Python 3.14 とは非干渉（無印 `python` は3.14のまま）。
  - 起動時に HuggingFace 埋め込みモデル(all-MiniLM-L6-v2, RAG用)取得で Windows のシンボリックリンク
    権限エラーが出るが、HTTPフォールバックで続行され**実害なし**。
  - `DATA_DIR` を固定（`C:/Users/ngsn4/AppData/Local/open-webui/data`）することで管理者アカウント・
    接続設定が永続化される。

- **npm スクリプトでの起動統合（2026-07-13）**: プロジェクト直下 [package.json](../package.json) に
  `concurrently` + `cross-env` で以下を用意。humanllm と Open WebUI を1コマンドで、または個別に起動可能。
  - `npm run dev` … サーバ側(humanllm: API :3000 + オペレーターUI :5173) と クライアント側(Open WebUI :8080) を同時起動
  - `npm run dev:server` … humanllm のみ（`npm --prefix humanllm run dev` に委譲）
  - `npm run dev:client`（= `npm run openwebui`）… Open WebUI のみ
  - 注: `.webui_secret_key` は Open WebUI がカレントに自動生成するセッション署名鍵。git管理するなら
    `.gitignore` 推奨。

## 参考リンク

- [Open WebUI: Reasoning & Thinking Models（thinkタグの折りたたみ表示）](https://docs.openwebui.com/features/chat-conversations/chat-features/reasoning-models/)
- [Open WebUI: Events（__event_emitter__ の status/citation ほか）](https://docs.openwebui.com/features/extensibility/plugin/development/events/)
- [Open WebUI: OpenAI互換プロバイダ接続](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/)
- [citation イベントの形式（Discussion #16099）](https://github.com/open-webui/open-webui/discussions/16099)
