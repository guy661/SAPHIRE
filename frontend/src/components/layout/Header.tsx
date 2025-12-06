import { AppBar, Toolbar, IconButton, Typography, Box, Menu, MenuItem, Avatar } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause'; // Import PauseIcon
import { useAuth } from '../../context/AuthContext';
import { useState, useEffect, useRef } from 'react'; // Import useEffect and useRef

interface HeaderProps {
    handleDrawerToggle: () => void;
}

export default function Header({ handleDrawerToggle }: HeaderProps) {
    const { user, logout } = useAuth();
    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null); // Ref to hold the audio object

    const handleMenu = (event: React.MouseEvent<HTMLElement>) => {
        setAnchorEl(event.currentTarget);
    };

    const handleClose = () => {
        setAnchorEl(null);
    };

    const handleLogout = () => {
        handleClose();
        logout();
    }

    const handlePlayAudio = () => {
        if (isPlaying && audioRef.current) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            // If audio object doesn't exist or is paused, create a new one and play
            if (!audioRef.current) {
                const audio = new Audio('/api/audio-summary');
                audioRef.current = audio;
                audio.addEventListener('ended', () => {
                    setIsPlaying(false);
                    audioRef.current = null; // Clean up after finishing
                });
                audio.addEventListener('error', () => {
                    console.error("Error playing audio.");
                    setIsPlaying(false);
                    // Optionally show an error to the user
                });
            }
            audioRef.current.play().catch(e => console.error("Audio playback failed:", e));
            setIsPlaying(true);
        }
    };
    
    // Cleanup effect
    useEffect(() => {
        // This function will be called when the component unmounts
        return () => {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
        };
    }, []);


    return (
        // The AppBar now gets its styling directly from the theme (glassmorphism)
        <AppBar position="absolute" elevation={0}>
            <Toolbar>
                <IconButton
                    color="inherit"
                    aria-label="open drawer"
                    edge="start"
                    onClick={handleDrawerToggle}
                    sx={{
                        mr: 2,
                        // Always display the toggle button
                    }}
                >
                    <MenuIcon />
                </IconButton>
                <Typography component="h1" variant="h6" color="inherit" noWrap sx={{ flexGrow: 1 }}>
                    Dashboard
                </Typography>
                <IconButton color="inherit" onClick={handlePlayAudio}>
                    {isPlaying ? <PauseIcon /> : <PlayArrowIcon />}
                </IconButton>
                <Box>
                    <IconButton onClick={handleMenu} sx={{ p: 0 }}>
                        <Avatar sx={{ width: 32, height: 32 }}>{user?.username.charAt(0).toUpperCase()}</Avatar>
                    </IconButton>
                    <Menu
                        id="menu-appbar"
                        anchorEl={anchorEl}
                        anchorOrigin={{
                            vertical: 'bottom',
                            horizontal: 'right',
                        }}
                        keepMounted
                        transformOrigin={{
                            vertical: 'top',
                            horizontal: 'right',
                        }}
                        open={Boolean(anchorEl)}
                        onClose={handleClose}
                    >
                        <MenuItem onClick={handleClose}>Profil</MenuItem>
                        <MenuItem onClick={handleLogout}>Abmelden</MenuItem>
                    </Menu>
                </Box>
            </Toolbar>
        </AppBar>
    );
}
