import {
    Box, List, ListItemButton, ListItemIcon, ListItemText, IconButton,
    Typography, Divider, useTheme, Dialog, DialogActions, DialogContent,
    DialogContentText, DialogTitle, TextField, Button, ListSubheader
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import { NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getDashboards, createDashboard } from '../../services/api';

interface SidebarContentProps {
    open?: boolean;
    toggleDrawer: () => void;
}

export default function SidebarContent({ open, toggleDrawer }: SidebarContentProps) {
    const theme = useTheme();
    const [dashboards, setDashboards] = useState<any[]>([]);
    const [isDialogOpen, setDialogOpen] = useState(false);
    
    useEffect(() => {
        getDashboards()
            .then(data => setDashboards(data))
            .catch(err => console.error('Fehler beim Laden der Dashboards für die Sidebar.', err));
    }, []);

    const handleCreateDashboard = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const dashboardName = formData.get('name') as string;
        try {
            const newDashboard = await createDashboard(dashboardName);
            setDashboards(prev => [...prev, newDashboard]);
            setDialogOpen(false);
        } catch (err) {
            console.error(err);
        }
    };

    return (
        <>
            {/* Header of the Sidebar */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    px: open ? 2 : '12px',
                    height: '64px',
                    transition: 'padding .2s',
                }}
            >
                <Typography variant="h6" component="div" sx={{ flexGrow: 1, opacity: open ? 1 : 0, transition: 'opacity 0.2s', whiteSpace: 'nowrap' }}>
                    Saphire
                </Typography>
                <IconButton onClick={toggleDrawer}>
                    <ChevronLeftIcon sx={{ transform: open ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }} />
                </IconButton>
            </Box>
            <Divider />

            {/* Navigation & Dashboard List */}
            <List
                component="nav"
                sx={{ p: open ? 1 : '8px 0', flexGrow: 1, overflowY: 'auto' }}
                subheader={
                    open ? <ListSubheader component="div">Dashboards</ListSubheader> : null
                }
            >
                {dashboards.map((dashboard) => (
                    <ListItemButton
                        key={dashboard.id}
                        component={NavLink}
                        to={`/dashboard/${dashboard.id}`}
                        title={dashboard.name}
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
                        <ListItemIcon sx={{ minWidth: 0, mr: open ? 3 : 'auto', justifyContent: 'center', transition: 'margin .2s' }}>
                            <DashboardIcon fontSize="small" />
                        </ListItemIcon>
                        <ListItemText primary={dashboard.name} sx={{ opacity: open ? 1 : 0, transition: 'opacity .2s' }} />
                    </ListItemButton>
                ))}
            </List>
            
            <Divider />

            {/* Action footer */}
            <Box sx={{ p: open ? 2 : 1, transition: 'padding .2s' }}>
                <Button
                    variant="contained"
                    onClick={() => setDialogOpen(true)}
                    fullWidth
                    startIcon={open ? <AddCircleOutlineIcon /> : null}
                    sx={{
                        justifyContent: open ? 'flex-start' : 'center',
                        minWidth: 0,
                        px: open ? 2 : 0,
                    }}
                >
                    {open ? 'Neues Dashboard' : <AddCircleOutlineIcon />}
                </Button>
            </Box>

             {/* --- Create Dialog --- */}
             <Dialog open={isDialogOpen} onClose={() => setDialogOpen(false)} PaperProps={{ component: 'form', onSubmit: handleCreateDashboard }}>
                <DialogTitle>Neues Dashboard</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        Geben Sie Ihrem neuen Dashboard einen prägnanten Namen.
                    </DialogContentText>
                    <TextField autoFocus required margin="dense" id="name" name="name" label="Dashboard-Name" type="text" fullWidth variant="outlined" sx={{ mt: 2 }}/>
                </DialogContent>
                <DialogActions sx={{ p: 3 }}>
                    <Button onClick={() => setDialogOpen(false)}>Abbrechen</Button>
                    <Button type="submit" variant="contained">Erstellen</Button>
                </DialogActions>
            </Dialog>
        </>
    );
}
