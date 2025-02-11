interface FontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

declare interface Window {
  queryLocalFonts(): Promise<FontData[]>;
} 