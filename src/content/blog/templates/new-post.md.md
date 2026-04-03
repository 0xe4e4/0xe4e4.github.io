---
# title / date は必須（Astro の blog コレクション）
# 挿入時に日時を入れる: Obsidian「テンプレート」の {{date}} / {{time}}（下記 .obsidian/templates.json の形式に従う）
# 日付だけにしたいときは date の行を手で YYYY-MM-DD に直すか、T以降を削除
title: "{{title}}"
description: この記事の要約（分析の結論など）を1行で
date: "{{date}}T{{time}}"
# updatedDate: 任意。追記したら更新。初回は date と同じで挿入される
updatedDate: "{{date}}T{{time}}"
# heroImage: 任意。src/assets からの相対パス（例）
heroImage: ../../assets/blog-placeholder-about.jpg
tags:
  - 日記
---
