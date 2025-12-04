import { motion, useAnimation } from 'framer-motion';
import { useRef } from 'react';
import { useMousePosition } from '../hooks/useMousePosition';
import { Box, styled, SxProps, Theme, useTheme } from '@mui/material';

// --- Styled Components ---

const CardWrapper = styled(motion.div)(({ theme }) => ({
    width: '100%',
    height: '100%',
    position: 'relative',
    borderRadius: theme.shape.borderRadius,
    border: `1px solid ${theme.palette.divider}`,
    overflow: 'hidden',
    backgroundColor: theme.palette.background.paper, // Using theme color
    backdropFilter: 'blur(12px)', // Consistent blur
    // Add a transition for the background color/filter for any potential future changes
    transition: 'background-color 0.3s ease, border-color 0.3s ease',
}));

const GlowEffect = styled(motion.div)({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    willChange: 'background', // Performance optimization
});

// --- Component ---

interface InteractiveCardProps {
    children: React.ReactNode;
    sx?: SxProps<Theme>;
}

export default function InteractiveCard({ children, sx }: InteractiveCardProps) {
    const cardRef = useRef<HTMLDivElement>(null);
    const { x, y } = useMousePosition(cardRef); // Direct destructuring
    const controls = useAnimation();
    const theme = useTheme();

    // The card itself will handle its entry animation
    const itemVariants = {
        hidden: { y: 20, opacity: 0 },
        visible: {
            y: 0,
            opacity: 1,
            transition: { type: 'spring', stiffness: 120, damping: 14 },
        },
    };

    // The glow effect has a smooth transition
    const gradientVariants = {
        initial: { opacity: 0, transition: { type: 'ease', duration: 0.5 } },
        hover: { opacity: 1, transition: { type: 'ease', duration: 0.3 } },
    };
    
    // Use the theme's palette for the glow
    const glowColor1 = theme.palette.primary.main;
    const glowColor2 = theme.palette.secondary.main;
    
    return (
        <CardWrapper
            ref={cardRef}
            variants={itemVariants} // Applies the entry animation
            whileHover="hover"
            onHoverStart={() => controls.start("hover")}
            onHoverEnd={() => controls.start("initial")}
            sx={sx} // Allow overriding styles
        >
            <GlowEffect
                style={{
                    // A more complex, softer gradient
                    background: `radial-gradient(600px circle at ${x}px ${y}px, ${glowColor1}20, transparent 40%), radial-gradient(400px circle at ${x}px ${y}px, ${glowColor2}15, transparent 50%)`,
                }}
                variants={gradientVariants}
                initial="initial"
                animate={controls}
            />
            
            {/* The actual content of the card */}
            <Box sx={{ position: 'relative', zIndex: 1, height: '100%' }}>
                {children}
            </Box>
        </CardWrapper>
    );
}
