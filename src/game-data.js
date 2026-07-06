export const DATA = [
  { id: "love-ihsan", group: "love", arabic: "الْمُحْسِنِينَ", persian: "نیکوکاران، اهل احسان" },
  { id: "love-tawwabin", group: "love", arabic: "التَّوَّابِينَ", persian: "بسیار توبه‌کنندگان، بازگشت‌کنندگان به سوی خدا" },
  { id: "love-mutatahhirin", group: "love", arabic: "الْمُتَطَهِّرِينَ", persian: "پاکیزگی‌جویان، کسانی که خود را پاک می‌کنند" },
  { id: "love-muttahhirin", group: "love", arabic: "الْمُطَّهِّرِينَ", persian: "پاکان، پاک‌جویان" },
  { id: "love-muttaqin", group: "love", arabic: "الْمُتَّقِينَ", persian: "پرهیزگاران، تقواپیشگان" },
  { id: "love-sabirin", group: "love", arabic: "الصَّابِرِينَ", persian: "شکیبایان، استقامت‌کنندگان" },
  { id: "love-mutawakkilin", group: "love", arabic: "الْمُتَوَكِّلِينَ", persian: "توکل‌کنندگان به خدا" },
  { id: "love-muqsitin", group: "love", arabic: "الْمُقْسِطِينَ", persian: "دادگران، عدالت‌پیشگان" },
  {
    id: "love-saff",
    group: "love",
    arabic: "الَّذِينَ يُقَاتِلُونَ فِي سَبِيلِهِ صَفًّا",
    persian: "کسانی که در راه خدا منظم، یکپارچه و استوار می‌ایستند/می‌جنگند"
  },
  { id: "love-ittiba", group: "love", arabic: "مُتَّبِعُو الرَّسُول", persian: "پیروان پیامبر" },
  {
    id: "love-adillah",
    group: "love",
    arabic: "أَذِلَّةٌ عَلَى الْمُؤْمِنِينَ",
    persian: "فروتنان و مهربانان نسبت به مؤمنان"
  },
  {
    id: "love-aizzah",
    group: "love",
    arabic: "أَعِزَّةٌ عَلَى الْكَافِرِينَ",
    persian: "استواران و عزتمندان در برابر کافران"
  },
  {
    id: "love-mujahidun",
    group: "love",
    arabic: "الْمُجَاهِدُونَ فِي سَبِيلِ اللَّهِ",
    persian: "تلاش‌گران و مجاهدان در راه خدا"
  },
  {
    id: "love-la-yakhafun",
    group: "love",
    arabic: "لَا يَخَافُونَ لَوْمَةَ لَائِمٍ",
    persian: "کسانی که از سرزنشِ سرزنش‌کنندگان نمی‌ترسند"
  },

  { id: "dislike-mutadin", group: "dislike", arabic: "الْمُعْتَدِينَ", persian: "تجاوزگران، از حد گذرندگان" },
  { id: "dislike-fasad", group: "dislike", arabic: "الْفَسَاد", persian: "فساد، تباهی" },
  {
    id: "dislike-kaffar-athim",
    group: "dislike",
    arabic: "كَفَّارٍ أَثِيمٍ",
    persian: "ناسپاسِ گناه‌پیشه، حق‌پوشِ گناهکار"
  },
  { id: "dislike-kafirin", group: "dislike", arabic: "الْكَافِرِينَ", persian: "کافران، منکران حق" },
  { id: "dislike-zalimin", group: "dislike", arabic: "الظَّالِمِينَ", persian: "ستمگران، ظلم‌کنندگان" },
  { id: "dislike-mukhtal-fakhur", group: "dislike", arabic: "مُخْتَالٍ فَخُورٍ", persian: "خودپسند و فخرفروش" },
  {
    id: "dislike-khawwan-athim",
    group: "dislike",
    arabic: "خَوَّانًا أَثِيمًا",
    persian: "خیانت‌پیشه و گناهکار"
  },
  {
    id: "dislike-jahr",
    group: "dislike",
    arabic: "الْجَهْرَ بِالسُّوءِ مِنَ الْقَوْلِ",
    persian: "آشکارا بدگویی کردن، سخن بد را علنی کردن"
  },
  { id: "dislike-mufsidin", group: "dislike", arabic: "الْمُفْسِدِينَ", persian: "فسادگران، تباهی‌آفرینان" },
  { id: "dislike-musrifin", group: "dislike", arabic: "الْمُسْرِفِينَ", persian: "اسراف‌کنندگان، زیاده‌روان" },
  { id: "dislike-khainin", group: "dislike", arabic: "الْخَائِنِينَ", persian: "خیانت‌کاران" },
  { id: "dislike-mustakbirin", group: "dislike", arabic: "الْمُسْتَكْبِرِينَ", persian: "متکبران، گردن‌کشان" },
  {
    id: "dislike-khawwan-kafur",
    group: "dislike",
    arabic: "خَوَّانٍ كَفُورٍ",
    persian: "بسیار خیانت‌کار و بسیار ناسپاس"
  },
  {
    id: "dislike-farihin",
    group: "dislike",
    arabic: "الْفَرِحِينَ",
    persian: "سرمستانِ مغرور، شادی‌کنندگانِ متکبرانه"
  }
];

export function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function createCards(items = DATA) {
  return shuffle(
    items.flatMap((item) => [
      {
        cardId: `${item.id}-ar`,
        pairId: item.id,
        group: item.group,
        side: "arabic",
        text: item.arabic
      },
      {
        cardId: `${item.id}-fa`,
        pairId: item.id,
        group: item.group,
        side: "persian",
        text: item.persian
      }
    ])
  );
}

export function isCorrectPair(a, b) {
  return Boolean(a && b && a.pairId === b.pairId && a.side !== b.side);
}

export function groupLabel(group) {
  return group === "love" ? "خدا دوست دارد" : "خدا دوست ندارد";
}

export function groupSymbol(group) {
  return group === "love" ? "♥" : "!";
}
