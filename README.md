# ShowTalk Taishi

<p align="center">
  <img
    src="docs/assets/brand/showtalk-taishi-concept-v3.png"
    alt="ShowTalk Taishi — 複数のKoeに耳を傾ける太子とAI家紋"
    width="100%"
  >
</p>

<p align="center">
  <strong>Every Koe gets a channel. Every channel can talk.</strong><br>
  複数のAIコーディングエージェントを、Slackから会話・連携・監督する。
</p>

<p align="center">
  <a href="README.md">日本語</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img alt="Status: Preview" src="https://img.shields.io/badge/status-preview-B6452C?style=flat-square">
  <img alt="Version: 0.0.1" src="https://img.shields.io/badge/version-0.0.1-263238?style=flat-square">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-3C873A?style=flat-square">
  <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-2D6A8A?style=flat-square">
</p>

ShowTalk Taishiは、AIコーディングエージェントのためのローカルファーストな
Slackフロントエンド兼スイッチボードです。Codexの永続スレッドを日常的に
Slackから操作しながら、将来のClaude Code、Gemini CLIなども接続できる
`AgentAdapter`境界を保ちます。

名前の由来は、複数人の声を同時に聞き分けたと伝えられる聖徳太子です。
Slackチャンネルごとに永続するAIの人格を **Koe（声）** と呼び、人間による
監督と、許可されたKoe同士の相談をひとつの場所にまとめます。

> [!IMPORTANT]
> 現在は実行可能なプレリリース版です。公開ソースは`0.0.1` previewで、
> 安定版v0.1やnpm公開版ではありません。v0.1までに設定形式が変わる可能性があります。

## なにができるのか

```text
                              Human
                                │
                                ▼
                              Slack
                                │ Socket Mode
                                ▼
                       ┌─ ShowTalk Taishi ─┐
                       │  Gateway + Policy │
                       └─────────┬─────────┘
                                 │
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
              実装Koe         レビューKoe       運用Koe
                 │               │               │
              Codex           Codex           Codex
            App Server      App Server      App Server
                 └──── 許可された agent.send 相談 ────┘
```

Slackは、人間との会話、Koeのディレクトリ、活動ログ、承認画面を担います。
Koe間のメッセージはSlackイベントを経由せず、Gatewayが直接配送するため、
ルーティングが明示され、bot同士の誤反応ループを避けられます。

最初の実装済みアダプターはCodex App Serverをstdioで使用します。Slackとは
Socket Modeで接続するため、ホストのMacやLinuxに公開HTTPサーバーは不要です。

## 主な機能

| | 機能 | 内容 |
| --- | --- | --- |
| 🗣️ | **永続するKoe** | チャンネル単位またはSlackスレッド単位で、Codexスレッドを継続利用 |
| 🔀 | **Koe間の相談** | allowlist、scope、hop数、busy保護付きの`agent.send`で別Koeへ直接相談 |
| ✅ | **Slackネイティブ確認** | コマンド、ファイル変更、通常選択、非Git外部操作、exact Git planをBlock Kitで明確に分離 |
| 📎 | **画像・音声** | 複数画像のnative入力、音声ファイルの安全な受信、要求元スレッドに束縛された返信、インライン生成画像の投影 |
| ⏯️ | **運用コントロール** | Status、Interrupt、approver限定Gateway restart、backend threadとmappingの永続化 |
| 🎭 | **Koeごとの表示** | call name、role、Slack表示名・アイコン、Slack専用persona |
| 🧭 | **管理UI** | loopback限定UIでmappingと実行時変更可能なmodel設定を管理 |
| 🔌 | **ローカルMCP** | `agent.list`、`agent.status`、`agent.send`、`slack.post`、`slack.reply`を権限境界内で提供 |

Koeの会話mappingは2種類あります。

- `channel`: Slackチャンネル全体を、ひとつの永続backend threadへ対応付けます。
- `slack_thread`: Slackのroot threadごとに、別のbackend threadを作成・再開します。

Koe間の到達性はfail closedです。送信元Koeは`consultations`に登録された相手へ、
各関係に設定されたscopeの範囲内でのみ相談できます。`agent.send`によるKoe訪問は、
Codex内部のsub-agentとは別の仕組みです。音声はprivate spool内のlocal fileとして
Koeへ渡され、理解や文字起こしはworkspaceで利用できる別toolに依存します。

## Quick start

> [!WARNING]
> 信頼できるself-hosted workstationでのみ実行してください。Management UIとMCPを
> 外部公開せず、Codex側のsandboxとapproval policyも制限します。実repositoryへ
> 接続する前に[security model（英語）](docs/security.md)を確認してください。

### 必要なもの

- macOSまたはLinux
- Node.js 22以上
- インストール・認証済みの`codex` CLI
- Slack Appを作成・インストールできる権限

### 1. インストール

```bash
git clone https://github.com/surugawan-ebi/showtalk-taishi.git
cd showtalk-taishi
npm ci
npm run build
npm link
taishi init
```

### 2. Slack Appを準備

[`slack/manifest.yaml`](slack/manifest.yaml)からSlack Appを作成し、Socket Modeを
有効化します。`connections:write`を持つapp-level tokenを作成してAppを
workspaceへインストールし、設定した各Koeチャンネルへ招待してください。
同梱のv0.1 manifestが対象とするのは、Appを招待したpublic channelです。private
channelとDMには対応していません。token rotationも未対応のため、tokenはowner-onlyな
環境で保護し、漏えい時はSlack側で失効・再発行してください。

### 3. private設定を読み込んで起動

`config.yaml`が参照する環境変数を設定します。token、実際のchannel ID、workspace
path、stateはGitへ追加しないでください。

```bash
export SLACK_APP_TOKEN='xapp-...'
export SLACK_BOT_TOKEN='xoxb-...'
export SLACK_APPROVER_USER_ID='U0123456789'
export TAISHI_STATE_FILE="$HOME/.showtalk-taishi/state.json"
export CODEX_COMMAND='codex'
export IMPLEMENTER_WORKSPACE='/path/to/project-a'
export SLACK_CHANNEL_IMPLEMENTER='C0123456789'
export SLACK_CHANNEL_REVIEWER='C9876543210'

taishi doctor
taishi start
```

設定全体、既存Codex threadのbinding、Koe identity、persona、consultation policy、
management UIについては[設定ガイド](docs/configuration.md)を参照してください。
このpreviewはnpm packageを`private`にしているため、`npm install -g`ではなく
source checkoutから利用します。

## 確認と承認のモデル

Slackに表示される確認は、同じ強度の保証ではありません。

| 経路 | 保証すること |
| --- | --- |
| Codex command / file change | 実行中のApp Server approval RPCをSlackへ投影し、そのrequestへ人間の回答を返す |
| 非Git external action | 表示した`Target` / `Scope` / `Impact`への人間確認。後続commandをexact planとしてhash固定・強制する仕組みではない |
| workspace-git | optional integrationがoperation、full plan hash、scope、expiry、HEAD / snapshotを束縛し、実行直前に再検証 |

通常選択は外部writeを承認しません。各経路の詳細は
[運用ガイド（英語）](docs/operations.md)を参照してください。

## 安全性の境界

- 信頼できるself-hosted workstation向けです。信頼できないlocal OS userを安全に
  分離するmulti-tenant sandboxではありません。
- Management UIとKoeごとのMCP endpointはloopback限定です。proxyやport forwardで
  公開しないでください。
- Slack/Codex credentialは環境変数またはowner-only fileへ保存し、Gitへ追加しません。
- Gatewayを通る副作用はPermission Engineで検査されます。ただし、backendへ別途与えた
  権限までは無効化できないため、Codex側のsandboxとapproval policyも制限してください。
- 非Git外部操作の確認は、表示内容に対するlive requestへの回答です。後続commandを
  Taishiが機械的に固定・再検証するexact-plan保証ではありません。
- Exact Git approvalはoperation、plan hash、Slack message、approver、live turnへ束縛され、
  Slack回答後に同じApp Server turnが再開した時も、workspace-gitの状態と完全一致した
  操作だけを実行できます。
- Gateway restart後もbackend threadとmappingは保持され、次のmessageで再開できます。
  進行中turnとpending approvalは継続せず、中断または失効します。

Exact Git approvalには、operatorが別途導入する
[workspace-git integration](docs/workspace-git-integration.md)が必要です。
未導入でもSlackとCodexの通常routingは利用できます。実repositoryやKoe間相談へ
接続する前に、[security model](docs/security.md)を確認してください。脆弱性は
[SECURITY.md](SECURITY.md)のprivate processで報告してください。

## ドキュメント

- [設定（英語）](docs/configuration.md)
- [運用とSlack上の挙動（英語）](docs/operations.md)
- [Gateway restartとapproval bridgeの検証（英語）](docs/gateway-restart-verification.md)
- [任意のworkspace-git連携（英語）](docs/workspace-git-integration.md)
- [Architecture（英語）](docs/architecture.md)
- [Security model（英語）](docs/security.md)
- [Brand assets（英語）](docs/assets/brand/README.md)
- [Contributing（英語）](CONTRIBUTING.md)
- [設定例](examples/config.example.yaml)

## 開発と検証

通常の変更:

```bash
npm run check
```

release向け・cross-cuttingな変更:

```bash
npm run verify
```

Codex structured input、Slack choice、approval、continuation、turn mode、restart activationを
変更した場合:

```bash
npm run verify:approval-bridge
```

これは決定的なapproval bridge testに加え、実際のCodex App Serverへ回答を返す
round-trip smokeを実行します。Worker restartを伴う変更は、さらに
[公開live acceptance gate](docs/gateway-restart-verification.md)を完了してください。

Slackへは接続しない、任意のreal-Codex smoke test:

```bash
npm run smoke:codex-mcp
npm run smoke:codex-agent-send
npm run smoke:codex-resume
```

## ライセンス

[Apache License 2.0](LICENSE)
