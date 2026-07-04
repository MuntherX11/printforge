export interface FontDef {
  key: string
  label: string
  file: string
}

export const ARABIC_FONTS: FontDef[] = [
  { key: 'arefruqaa-bold', label: 'Aref Ruqaa Bold — رقعة', file: 'ArefRuqaa-Bold.ttf' },
  { key: 'arefruqaa', label: 'Aref Ruqaa — رقعة', file: 'ArefRuqaa-Regular.ttf' },
  { key: 'amiri-bold', label: 'Amiri Bold — نسخ', file: 'Amiri-Bold.ttf' },
  { key: 'amiri', label: 'Amiri — نسخ', file: 'Amiri-Regular.ttf' },
  { key: 'reemkufi', label: 'Reem Kufi — كوفي', file: 'ReemKufi-Regular.ttf' },
]

export const ENGLISH_FONTS: FontDef[] = [
  { key: 'pacifico', label: 'Pacifico (script)', file: 'Pacifico-Regular.ttf' },
  { key: 'poppins', label: 'Poppins (block)', file: 'Poppins-SemiBold.ttf' },
]

export const LETTER_FONTS: FontDef[] = [
  { key: 'poppins', label: 'Poppins', file: 'Poppins-SemiBold.ttf' },
  { key: 'pacifico', label: 'Pacifico', file: 'Pacifico-Regular.ttf' },
]

export function findFont(list: FontDef[], key: string): FontDef {
  return list.find((f) => f.key === key) ?? list[0]
}

export function fontUrl(def: FontDef): string {
  return `${import.meta.env.BASE_URL}fonts/${def.file}`
}
