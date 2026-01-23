import { AnimationStyle, Subtitle } from '@/types/timeline';

/**
 * Unified rendering logic for subtitles, shared between preview and export.
 * Ensures all pixel-based properties are scaled proportionally to the canvas height.
 */
export function renderSubtitles(
    ctx: CanvasRenderingContext2D,
    subtitles: Subtitle[],
    style: AnimationStyle,
    currentTime: number,
    canvasWidth: number,
    canvasHeight: number
): void {
    const EPSILON = 0.0005; // 0.5ms epsilon for robust boundary comparison

    // Base height for scaling relative units (e.g., 1080p is the design base)
    const BASE_HEIGHT = 1080;
    const scaleFactor = canvasHeight / BASE_HEIGHT;

    // Helper to scale pixel values
    const scaleValue = (val: number) => val * scaleFactor;

    // Find active subtitles
    const activeSubtitles = subtitles.filter((subtitle) => {
        const isActive = currentTime >= subtitle.startTime - EPSILON && currentTime < subtitle.endTime - EPSILON;
        const isExiting = currentTime >= subtitle.endTime - style.fadeOutDuration - EPSILON
            && currentTime < subtitle.endTime - EPSILON;
        return isActive || isExiting;
    });

    if (activeSubtitles.length === 0) return;

    // Process text
    const processText = (text: string): string => {
        let result = text;
        if (style.textCase === 'uppercase') result = result.toUpperCase();
        else if (style.textCase === 'lowercase') result = result.toLowerCase();

        if (style.hidePunctuation) {
            const regex = new RegExp(
                `[${style.punctuationChars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]`,
                'g'
            );
            result = result.replace(regex, '');
        }

        if (style.removeAccents) {
            result = result.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            // normalize NFD doesn't handle Ñ and some others consistently depending on platform, 
            // but for basics it works. Let's stick to the user's manual logic for maximum safety with Spanish
            result = text
                .replace(/[áàäâã]/g, 'a')
                .replace(/[éèëê]/g, 'e')
                .replace(/[íìïî]/g, 'i')
                .replace(/[óòöôõ]/g, 'o')
                .replace(/[úùüû]/g, 'u')
                .replace(/[ÁÀÄÂÃ]/g, 'A')
                .replace(/[ÉÈËÊ]/g, 'E')
                .replace(/[ÍÌÏÎ]/g, 'I')
                .replace(/[ÓÒÖÔÕ]/g, 'O')
                .replace(/[ÚÙÜÛ]/g, 'U');
        }
        return result;
    };

    // Easing
    const easeOutBack = (x: number): number => {
        if (!style.useElasticEffect) return x;
        const c1 = style.bounceStrength;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    };

    const easeOutExpo = (x: number): number => {
        return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
    };

    const sortedActive = [...activeSubtitles].sort((a, b) => a.startTime - b.startTime);
    const firstSubtitle = sortedActive[0];
    const lastSubtitle = sortedActive[sortedActive.length - 1];

    let opacity = 1;
    let animScale = 1;

    if (currentTime >= firstSubtitle.startTime && currentTime < firstSubtitle.startTime + style.fadeInDuration) {
        const progress = (currentTime - firstSubtitle.startTime) / style.fadeInDuration;
        opacity = easeOutExpo(progress);
        const scaleProgress = easeOutBack(progress);
        animScale = 1 + ((style.initialScale - 1) * (1 - scaleProgress));
    } else if (currentTime >= lastSubtitle.endTime - style.fadeOutDuration && currentTime < lastSubtitle.endTime) {
        const progress = (lastSubtitle.endTime - currentTime) / style.fadeOutDuration;
        opacity = Math.max(0, Math.min(1, easeOutExpo(progress)));
    }

    opacity = Math.max(0, Math.min(1, opacity));

    ctx.save();

    // Scale positioning
    const xPos = (canvasWidth * style.position.x) / 100;
    const yPos = (canvasHeight * style.position.y) / 100;

    ctx.translate(xPos, yPos);
    ctx.scale(animScale, animScale);
    ctx.translate(-xPos, -yPos);

    const fontSize = scaleValue(style.fontSize);
    ctx.font = `${style.fontWeight} ${fontSize}px "${style.fontFamily}"`;
    ctx.textAlign = style.textAlign;
    ctx.textBaseline = 'middle';

    let allLines: { text: string; metrics: TextMetrics }[] = [];
    for (const subtitle of sortedActive) {
        const processed = processText(subtitle.text);
        const lines = processed
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => ({
                text: line,
                metrics: ctx.measureText(line),
            }));
        allLines.push(...lines);
    }

    allLines = allLines.slice(0, style.numberOfLines);
    if (allLines.length === 0) {
        ctx.restore();
        return;
    }

    const maxLineWidth = Math.max(...allLines.map((line) => line.metrics.width));
    const lineHeight = fontSize * 1.2;
    const totalTextHeight = lineHeight * allLines.length;

    // SCALE MARGINS
    const padding = {
        vertical: scaleValue(style.backgroundMarginVertical),
        horizontal: scaleValue(style.backgroundMarginHorizontal),
    };
    const bgWidth = maxLineWidth + padding.horizontal * 2;
    const bgHeight = totalTextHeight + padding.vertical * 2;

    // SCALE OFFSETS
    const bgOffsetX = scaleValue(style.backgroundOffsetX);
    const bgOffsetY = scaleValue(style.backgroundOffsetY);

    let bgX: number;
    switch (style.textAlign) {
        case 'left':
            bgX = xPos - bgWidth / 2 + maxLineWidth / 2 + bgOffsetX;
            break;
        case 'right':
            bgX = xPos - bgWidth / 2 - maxLineWidth / 2 + bgOffsetX;
            break;
        default:
            bgX = xPos - bgWidth / 2 + bgOffsetX;
    }
    const bgY = yPos - bgHeight / 2 + bgOffsetY;

    // DRAW BACKGROUND
    if (style.backgroundOpacity > 0) {
        ctx.fillStyle = `${style.backgroundColor}${Math.round(
            opacity * (style.backgroundOpacity / 1) * 255 // backgroundOpacity in types is 0..1? 
            // types.ts says backgroundOpacity: number and preset has 100 or 0.5.
            // Let's check types.ts again.
        ).toString(16).padStart(2, '0')}`;
        // Wait, Mi Alter Edu uses 100 as opacity. Default uses 0.5.
        // We will assume if > 1 it's 0-100, if <= 1 it's 0-1.
        const normalizedOpacity = style.backgroundOpacity > 1 ? style.backgroundOpacity / 100 : style.backgroundOpacity;
        ctx.fillStyle = `${style.backgroundColor}${Math.round(
            opacity * normalizedOpacity * 255
        ).toString(16).padStart(2, '0')}`;

        const radius = Math.min(scaleValue(style.backgroundBorderRadius), bgHeight / 2, bgWidth / 2);

        ctx.beginPath();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = ctx as any;
        if (typeof c.roundRect === 'function') {
            c.roundRect(bgX, bgY, bgWidth, bgHeight, radius);
        } else {
            // Manual fallback if roundRect not available (older browsers/environments)
            c.moveTo(bgX + radius, bgY);
            c.lineTo(bgX + bgWidth - radius, bgY);
            c.quadraticCurveTo(bgX + bgWidth, bgY, bgX + bgWidth, bgY + radius);
            c.lineTo(bgX + bgWidth, bgY + bgHeight - radius);
            c.quadraticCurveTo(bgX + bgWidth, bgY + bgHeight, bgX + bgWidth - radius, bgY + bgHeight);
            c.lineTo(bgX + radius, bgY + bgHeight);
            c.quadraticCurveTo(bgX, bgY + bgHeight, bgX, bgY + bgHeight - radius);
            c.lineTo(bgX, bgY + radius);
            c.quadraticCurveTo(bgX, bgY, bgX + radius, bgY);
        }
        ctx.fill();

        if (style.backgroundBorderWidth > 0) {
            ctx.strokeStyle = `${style.backgroundBorderColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
            ctx.lineWidth = scaleValue(style.backgroundBorderWidth);
            ctx.stroke();
        }
    }

    // DRAW TEXT
    const strokeWidth = scaleValue(style.strokeWidth);
    if (strokeWidth > 0) {
        ctx.strokeStyle = `${style.strokeColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = 'round';
    }

    ctx.fillStyle = `${style.textColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;

    let currentY = yPos - totalTextHeight / 2 + lineHeight / 2;
    allLines.forEach((line) => {
        if (strokeWidth > 0) ctx.strokeText(line.text, xPos, currentY);
        ctx.fillText(line.text, xPos, currentY);
        currentY += lineHeight;
    });

    ctx.restore();
}
