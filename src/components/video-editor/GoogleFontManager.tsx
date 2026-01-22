'use client';

import { useEffect } from 'react';
import { useTimelineStore } from '@/stores/timeline-store';
import { loadGoogleFont } from '@/lib/fonts/google-fonts';

/**
 * Manager component that ensures all Google Fonts used in the project
 * are loaded into the document.
 */
export function GoogleFontManager() {
    const tracks = useTimelineStore((state) => state.tracks);

    useEffect(() => {
        // Collect all font families used in tracks
        const fontFamilies = new Set(tracks.map((track) => track.style.fontFamily));

        // For each font, check if it's a known popular Google Font
        // or if it's not one of the default web-safe fonts
        const WEB_SAFE_FONTS = [
            'Arial', 'Helvetica', 'Verdana', 'Times New Roman',
            'Georgia', 'Courier New', 'Impact', 'Comic Sans MS',
            'Tahoma', 'Trebuchet MS', 'Inter'
        ];

        fontFamilies.forEach((family) => {
            if (!WEB_SAFE_FONTS.includes(family)) {
                // We assume any other font is a Google Font 
                // (or at least we try to load it from there)
                loadGoogleFont(family);
            }
        });
    }, [tracks]);

    return null;
}
