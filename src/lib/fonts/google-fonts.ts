/**
 * List of popular Google Fonts for quick access.
 */
export const POPULAR_GOOGLE_FONTS = [
    'Montserrat',
    'Roboto',
    'Open Sans',
    'Lato',
    'Poppins',
    'Oswald',
    'Raleway',
    'Nunito',
    'Playfair Display',
    'Ubuntu',
    'Merriweather',
    'Lora',
    'PT Sans',
    'Inter',
    'Inter Tight',
    'Bebas Neue',
    'Kanit',
    'Mukta',
    'Fira Sans',
    'Work Sans',
    'Quicksand',
    'Outfit',
    'Anton',
    'Pacifico',
    'Arvo',
    'Caveat',
    'Abel',
    'Exo 2',
    'Inconsolata',
    'Lobster',
    'Dancing Script',
    'Righteous',
    'Comfortaa',
    'Josefin Sans',
    'Kalam',
    'Fredoka',
    'Bree Serif',
    'Permanent Marker',
    'Satisfy',
    'Courgette',
    'Patua One',
    'Shadows Into Light',
    'Gloria Hallelujah',
    'Amatic SC',
];

const loadedFonts = new Set<string>();

/**
 * Loads a Google Font family dynamically by adding a <link> tag to the document head.
 * @param family The font family name.
 * @param preview If true, only loads the characters of the font name to save bandwidth.
 */
export function loadGoogleFont(family: string, preview: boolean = false) {
    if (typeof window === 'undefined') return;

    const cacheKey = preview ? `preview-${family}` : family;
    if (loadedFonts.has(cacheKey)) return;
    if (!preview && loadedFonts.has(`preview-${family}`)) {
        // If we already have a preview, we still need the full font
    } else if (loadedFonts.has(family)) {
        return;
    }

    const formattedFamily = family.replace(/\s+/g, '+');
    const linkId = `google-font-${preview ? 'p-' : ''}${family.toLowerCase().replace(/\s+/g, '-')}`;

    if (document.getElementById(linkId)) return;

    const link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';

    let url = `https://fonts.googleapis.com/css2?family=${formattedFamily}:wght@400;700;800;900&display=swap`;
    if (preview) {
        // Only load the characters of the family name for the preview
        const text = encodeURIComponent(family);
        url = `https://fonts.googleapis.com/css2?family=${formattedFamily}&text=${text}&display=swap`;
    }

    link.href = url;
    document.head.appendChild(link);
    loadedFonts.add(cacheKey);
}

/**
 * Ensures all requested font families are loaded and ready to use.
 * Returns a promise that resolves when all fonts are ready.
 */
export async function waitForFonts(families: string[]): Promise<void> {
    if (typeof window === 'undefined' || !('fonts' in document)) return;

    const loads = families.map(async (family) => {
        // Load the font metadata/link if not already done
        loadGoogleFont(family);

        // Wait for the specific font to be available in the browser's FontFaceSet
        try {
            // We check for 400, 700, 800, 900 weights
            const weights = ['400', '700', '800', '900'];
            await Promise.all(weights.map(weight =>
                document.fonts.load(`${weight} 16px "${family}"`)
            ));
        } catch (e) {
            console.warn(`Failed to wait for font "${family}":`, e);
        }
    });

    await Promise.all(loads);
    await document.fonts.ready;
}
