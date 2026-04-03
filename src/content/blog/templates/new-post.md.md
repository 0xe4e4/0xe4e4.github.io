---
# title / date は必須（Astro の blog コレクション）
# date: 日付だけ YYYY-MM-DD でも可。時刻まで出したい・同日の並び順を付けたいときは ISO 日時（例: 2026-04-03T21:30:00 または 2026-04-03T21:30:00+09:00）
title: "{{title}}"
description: この記事の要約（分析の結論など）を1行で
date: {{date}}
# updatedDate: 任意。追記したら更新。形式は date と同じ
updatedDate: {{date}}
# heroImage: 任意。src/assets からの相対パス（例）
heroImage: ../../assets/blog-placeholder-about.jpg
tags:
  - 日記
---
