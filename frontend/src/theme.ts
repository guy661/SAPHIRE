import { createTheme } from '@mui/material/styles';
import { deDE } from '@mui/material/locale';

// Define the color palette
const palette = {
    primary: {
        main: '#3a8dff', // A vibrant sapphire blue
        contrastText: '#ffffff',
    },
    secondary: {
        main: '#c850ff', // A soft magenta
        contrastText: '#ffffff',
    },
    background: {
        default: '#0d1117', // The very dark space blue from your CSS
        paper: 'rgba(20, 25, 33, 0.7)', // Slightly more transparent for a deeper glass effect
    },
    text: {
        primary: '#e6edf3', // A light grey-blue for primary text
        secondary: '#8b949e', // A slightly darker grey for secondary text
        disabled: '#484f58',
    },
    divider: 'rgba(230, 237, 243, 0.1)', // A faint divider
    error: {
        main: '#f85149',
    },
    success: {
        main: '#2ea043',
    }
};

// Create the theme instance
export const theme = createTheme({
    palette,
    typography: {
        fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        h3: {
            fontSize: '2.5rem', // Larger for more impact
            fontWeight: 700,
            letterSpacing: '-0.01em',
            lineHeight: 1.2,
        },
        h4: {
            fontSize: '1.75rem',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            lineHeight: 1.3,
        },
        h5: {
            fontSize: '1.25rem',
            fontWeight: 600,
            lineHeight: 1.4,
        },
        h6: {
             fontSize: '1.1rem',
            fontWeight: 600,
            lineHeight: 1.4,
        },
        body1: {
            fontSize: '1rem',
            lineHeight: 1.6,
        },
        body2: {
            fontSize: '0.9rem',
            lineHeight: 1.5,
            color: palette.text.secondary,
        },
        button: {
            textTransform: 'none',
            fontWeight: 600,
            fontSize: '0.9rem',
        },
    },
    components: {
        // --- General ---
        MuiPaper: {
            styleOverrides: {
                root: {
                    border: `1px solid ${palette.divider}`,
                },
                elevation0: {
                     border: 'none',
                }
            }
        },
        MuiButton: {
            styleOverrides: {
                root: {
                    borderRadius: 8,
                    padding: '8px 16px',
                    transition: 'transform 0.15s ease-in-out, background-color 0.2s ease, box-shadow 0.2s ease',
                    '&:hover': {
                        transform: 'scale(1.03)',
                    }
                },
                containedPrimary: {
                    boxShadow: `0 0 15px -5px ${palette.primary.main}`,
                    '&:hover': {
                         boxShadow: `0 0 25px -5px ${palette.primary.main}`,
                    }
                }
            }
        },
        MuiCard: {
            defaultProps: {
                elevation: 0,
            },
            styleOverrides: {
                root: {
                    borderRadius: 16,
                    backgroundColor: palette.background.paper,
                }
            }
        },
        // --- Layout ---
         MuiAppBar: {
            styleOverrides: {
                root: {
                    backgroundColor: 'rgba(13, 17, 23, 0.7)',
                    backdropFilter: 'blur(12px)',
                    borderBottom: `1px solid ${palette.divider}`,
                }
            }
        },
        MuiDrawer: {
            styleOverrides: {
                paper: {
                    backgroundColor: 'rgba(13, 17, 23, 0.7)',
                    backdropFilter: 'blur(12px)',
                    borderRight: `1px solid ${palette.divider}`,
                }
            }
        },
        // --- Form Elements ---
        MuiTextField: {
            styleOverrides: {
                root: {
                    '& .MuiOutlinedInput-root': {
                        borderRadius: 8,
                         '& fieldset': {
                            borderColor: palette.divider,
                        },
                        '&:hover fieldset': {
                            borderColor: 'rgba(230, 237, 243, 0.2)',
                        },
                        '&.Mui-focused fieldset': {
                            borderColor: palette.primary.main,
                        },
                    },
                }
            }
        },
        MuiDialog: {
            styleOverrides: {
                paper: {
                    borderRadius: 24, // Larger radius for a softer look
                     backgroundColor: 'rgba(20, 25, 33, 0.9)',
                    backdropFilter: 'blur(10px)',
                     border: `1px solid ${palette.divider}`,
                }
            }
        },
    },
}, deDE);
