import { Box, List, ListItemButton, ListItemIcon, ListItemText, IconButton, Typography, Divider, useTheme } from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import { NavLink } from 'react-router-dom';

interface SidebarContentProps {
    open?: boolean;
    toggleDrawer: () => void;
}

export default function SidebarContent({ open, toggleDrawer }: SidebarContentProps) {
    const theme = useTheme();
    
    return (
        <>
            {/* Header of the Sidebar */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between', 
                    px: open ? 2 : '12px', // Adjust padding when collapsed
                    height: '64px', // Match header height
                    transition: 'padding .2s',
                }}
            >
                <Typography variant="h6" component="div" sx={{ flexGrow: 1, opacity: open ? 1 : 0, transition: 'opacity 0.2s', whiteSpace: 'nowrap' }}>
                    Saphire
                </Typography>
                <IconButton onClick={toggleDrawer}>
                    {/* The icon now responds to the 'open' state, not the other way around */}
                    <ChevronLeftIcon sx={{ transform: open ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }} />
                </IconButton>
            </Box>
            <Divider />

            {/* Navigation List */}
            <List component="nav" sx={{ p: open ? 1 : '8px 0' }}>
                <ListItemButton
                    component={NavLink}
                    to="/"
                    title="Dashboards" // Add tooltip for collapsed state
                    sx={{
                        margin: '4px auto',
                        width: 'calc(100% - 16px)',
                        borderRadius: '8px',
                        justifyContent: open ? 'initial' : 'center',
                        px: 2.5,
                        '&.active': {
                            backgroundColor: theme.palette.action.selected,
                            '& .MuiListItemIcon-root': {
                                color: theme.palette.primary.main,
                            },
                        },
                    }}
                >
                    <ListItemIcon sx={{
                        minWidth: 0,
                        mr: open ? 3 : 'auto',
                        justifyContent: 'center',
                        transition: 'margin .2s'
                    }}>
                        <DashboardIcon />
                    </ListItemIcon>
                    <ListItemText primary="Dashboards" sx={{ opacity: open ? 1 : 0, transition: 'opacity .2s' }} />
                </ListItemButton>
                {/* Add other navigation items here in the same pattern */}
            </List>
        </>
    );
}
