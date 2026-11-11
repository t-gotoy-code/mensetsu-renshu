# AI面接練習（高校生向け）

就職試験・総合型選抜・学校推薦型選抜の面接を、AI面接官と練習できるWebアプリです。

- 画面（`index.html` と `images/`）は GitHub Pages で公開します。
- AIとの通信とスプレッドシートへの記録は Google Apps Script（`gas/Code.gs`）で動かします。
- AIは Groq の API を使います。APIキーは GAS のスクリプト プロパティ `GROQ_API_KEY` に保存し、このリポジトリには置きません。

## 面接官の写真

`images/` に `性別_年代.jpg` の名前で置くと、その面接官が写真で表示されます（ない場合は3Dの面接官）。

| ファイル | 面接官 |
|---|---|
| `male_young.jpg` / `male_middle.jpg` / `male_senior.jpg` | 男性 若手 / 中堅 / ベテラン |
| `female_young.jpg` / `female_middle.jpg` / `female_senior.jpg` | 女性 若手 / 中堅 / ベテラン |

同じ名前に `_talk`（口を開けた顔）、`_blink`（目を閉じた顔）を付けた画像を置くと、口パクとまばたきをします。
