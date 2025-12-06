import { motion, useAnimation } from 'framer-motion';
import { useRef, ReactNode } from 'react'; // Import ReactNode
import { useMousePosition } from '../hooks/useMousePosition';
import { Box, styled, SxProps, Theme, useTheme, IconButton } from '@mui/material';

// --- Styled Components ---

const CardWrapper = styled(motion.div)(({ theme }) => ({
    width: '100%',
    height: '100%',
    position: 'relative',
    borderRadius: theme.shape.borderRadius,
    border: `1px solid ${theme.palette.divider}`,
    overflow: 'hidden',
    backgroundColor: theme.palette.background.paper,
    backdropFilter: 'blur(12px)',
    transition: 'background-color 0.3s ease, border-color 0.3s ease',
}));

const GlowEffect = styled(motion.div)({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    willChange: 'background',
});

// --- Component ---

interface InteractiveCardProps {
    children: ReactNode;
    sx?: SxProps<Theme>;
    onLike?: () => void;
    onDislike?: () => void;
    likeIcon?: ReactNode;
    dislikeIcon?: ReactNode;
}

export default function InteractiveCard({ children, sx, onLike, onDislike, likeIcon, dislikeIcon }: InteractiveCardProps) {
    const cardRef = useRef<HTMLDivElement>(null);
    const { x, y } = useMousePosition(cardRef);
    const controls = useAnimation();
    const theme = useTheme();

    const itemVariants = {
        hidden: { y: 20, opacity: 0 },
        visible: { y: 0, opacity: 1, transition: { type: 'spring', stiffness: 120, damping: 14 } },
    };

    const gradientVariants = {
        initial: { opacity: 0, transition: { type: 'ease', duration: 0.5 } },
        hover: { opacity: 1, transition: { type: 'ease', duration: 0.3 } },
    };
    
    const glowColor1 = theme.palette.primary.main;
    const glowColor2 = theme.palette.secondary.main;
    
    const hasFeedbackControls = onLike || onDislike;

    return (
        <CardWrapper
            ref={cardRef}
            variants={itemVariants}
            whileHover="hover"
            onHoverStart={() => controls.start("hover")}
            onHoverEnd={() => controls.start("initial")}
            sx={sx}
        >
            <GlowEffect
                style={{
                    background: `radial-gradient(600px circle at ${x}px ${y}px, ${glowColor1}20, transparent 40%), radial-gradient(400px circle at ${x}px ${y}px, ${glowColor2}15, transparent 50%)`,
                }}
                variants={gradientVariants}
                initial="initial"
                animate={controls}
            />
            
            <Box sx={{ position: 'relative', zIndex: 1, height: '100%', paddingBottom: hasFeedbackControls ? '48px' : '0' }}>
                {children}
            </Box>

            {hasFeedbackControls && (
                 <Box
                    sx={{
                        position: 'absolute',
                        bottom: 8,
                        right: 8,
                        zIndex: 2,
                        display: 'flex',
                        gap: 0.5,
                        backgroundColor: 'rgba(0,0,0,0.2)',
                        borderRadius: '20px',
                        padding: '2px 4px',
                    }}
                >
                    {onLike && <IconButton size="small" onClick={onLike}>{likeIcon}</IconButton>}
                    {onDislike && <IconButton size="small" onClick={onDislike}>{dislikeIcon}</IconButton>}
                </Box>
            )}
        </CardWrapper>
    );
}
