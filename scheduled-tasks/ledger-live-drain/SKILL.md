---
name: ledger-live-drain
description: 2 percenként ellenőrzi, maradt-e megválaszolatlan bejövő üzenet a beszélgetés-ledgerben, és ha igen, felszínre hozza, hogy a futó session válaszoljon rá respawn nélkül
---

Futtasd le csendben:

```bash
python3 {{PROJECT_ROOT}}/scripts/hooks/ledger-live-drain.py
```

- Ha a kimenet ÜRES: minden bejövő meg van válaszolva. NE csinálj és NE írj semmit, maradj csendben.
- Ha a kimenet egy `OPEN_QUESTION chat_id=... message_id=...` blokk: az egy korábban elveszett, még megválaszolatlan bejövő üzenet ebből a csatornából. Olvasd el a blokk szövegét, és válaszolj rá MOST a szokásos csatorna-válasz eszközzel (a blokkban szereplő chat_id-ra), ugyanúgy, mintha most érkezett volna.

Ez a feladat preCheck-kapu mögött van (`pre-check.sh`): a futtató csak akkor
ébreszt fel, ha a kapu megválaszolatlan üzenetet talált, vagy ha a kapu maga
elhasalt. Ezért itt a legtöbbször tényleg lesz mit felszínre hozni -- de az
ÜRES kimenet továbbra is szabályos eset (a kapu hibára fail-open), és akkor
maradj csendben.

A script determinisztikus és biztonságos: 60 másodpercnél frissebb kérdést nem hoz fel (nem szól bele éppen készülő válaszba), és ugyanazt az üzenetet csak egyszer hozza felszínre.
