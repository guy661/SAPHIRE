import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Box, CssBaseline, Drawer as MuiDrawer, useTheme, useMediaQuery, styled, Theme } from '@mui/material';
import Header from '../components/layout/Header';
import SidebarContent from '../components/layout/Sidebar';

const drawerWidth = 240;
const collapsedDrawerWidth = 88; // A bit more space for centered icons

// --- Styled Components for a cleaner structure ---

const openedMixin = (theme: Theme) => ({
    width: drawerWidth,
    transition: theme.transitions.create('width', {
        easing: theme.transitions.easing.sharp,
        duration: theme.transitions.duration.enteringScreen,
    }),
    overflowX: 'hidden',
});

const closedMixin = (theme: Theme) => ({
    transition: theme.transitions.create('width', {
        easing: theme.transitions.easing.sharp,
        duration: theme.transitions.duration.leavingScreen,
    }),
    overflowX: 'hidden',
    width: collapsedDrawerWidth,
});

const Drawer = styled(MuiDrawer, { shouldForwardProp: (prop) => prop !== 'open' })(
    ({ theme, open }) => ({
        width: drawerWidth,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        boxSizing: 'border-box',
        ...(open && {
            ...openedMixin(theme),
            '& .MuiDrawer-paper': openedMixin(theme),
        }),
        ...(!open && {
            ...closedMixin(theme),
            '& .MuiDrawer-paper': closedMixin(theme),
        }),
    }),
);

// --- Main Component ---

export default function MainLayout() {
    const theme = useTheme();
    const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
    const [open, setOpen] = useState(isDesktop);

    const handleDrawerToggle = () => {
        setOpen(!open);
    };

    return (
        <Box sx={{ display: 'flex', height: '100vh' }}>
            <CssBaseline />
            
            {isDesktop ? (
                <Drawer variant="permanent" open={open}>
                    <SidebarContent open={open} toggleDrawer={handleDrawerToggle} />
                </Drawer>
            ) : (
                 <MuiDrawer
                    variant="temporary"
                    open={open}
                    onClose={handleDrawerToggle}
                    ModalProps={{ keepMounted: true }} // Better open performance on mobile.
                    sx={{
                        '& .MuiDrawer-paper': { boxSizing: 'border-box', width: drawerWidth },
                    }}
                >
                    <SidebarContent open={open} toggleDrawer={handleDrawerToggle} />
                </MuiDrawer>
            )}

            <Box component="main" sx={{ flexGrow: 1, p: 3, width: '100%' }}>
                {/* Header now lives inside the main content box for simpler positioning */}
                <Header handleDrawerToggle={handleDrawerToggle} />
                
                {/* Main content area */}
                <Box sx={{ flexGrow: 1, mt: '80px' /* Header height + margin */, height: 'calc(100% - 80px)', overflowY: 'auto' }}>
                    <Outlet /> {/* Renders the current page */}
                </Box>
            </Box>
        </Box>
    );
}
