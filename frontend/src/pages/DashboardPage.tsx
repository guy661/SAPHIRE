import {
    Typography, Button, Box, Dialog, DialogActions, DialogContent, 
    DialogContentText, DialogTitle, TextField, Skeleton, List, ListItem,
    CardActions, useTheme, Fade
} from '@mui/material';
import { useEffect, useState } from 'react';
import { getDashboards, createDashboard } from '../services/api';
import { Link as RouterLink } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';

// A new, dedicated component for each list item for better structure and animation control.
const DashboardListItem = ({ dashboard, isHovered, onHoverStart, onHoverEnd }: any) => {
    const theme = useTheme();

    const listItemVariants = {
        hidden: { y: 20, opacity: 0 },
        visible: { y: 0, opacity: 1, transition: { type: 'spring', stiffness: 100 } },
    };

    const actionsVariants = {
        hidden: { opacity: 0, x: -10 },
        visible: { opacity: 1, x: 0 },
    };

    return (
        <motion.li variants={listItemVariants} style={{ listStyle: 'none' }}>
            <ListItem
                onHoverStart={onHoverStart}
                onHoverEnd={onHoverEnd}
                component={motion.div}
                whileHover={{ scale: 1.02, backgroundColor: theme.palette.action.hover }}
                sx={{
                    p: 3,
                    mb: 2,
                    borderRadius: '12px',
                    border: '1px solid',
                    borderColor: 'divider',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s ease',
                }}
            >
                <Box>
                    <Typography variant="h6" component="h2">{dashboard.name}</Typography>
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                        {dashboard.user_intent || 'Kein Thema festgelegt'}
                    </Typography>
                </Box>
                <AnimatePresence>
                    {isHovered && (
                        <motion.div variants={actionsVariants} initial="hidden" animate="visible" exit="hidden">
                            <CardActions>
                                <Button component={RouterLink} to={`/dashboard/${dashboard.id}`} size="small" endIcon={<ArrowForwardIcon />}>Details</Button>
                                <Button component={RouterLink} to={`/dashboard/${dashboard.id}/edit`} size="small">Thema</Button>
                            </CardActions>
                        </motion.div>
                    )}
                </AnimatePresence>
            </ListItem>
        </motion.li>
    );
};


export default function DashboardPage() {
    const [dashboards, setDashboards] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isDialogOpen, setDialogOpen] = useState(false);
    const [hoveredId, setHoveredId] = useState<string | null>(null);

    useEffect(() => {
        setIsLoading(true);
        // Simulate network latency for a better loading experience feel
        setTimeout(() => {
            getDashboards()
                .then(data => setDashboards(data))
                .catch(err => setError('Fehler beim Laden der Dashboards.'))
                .finally(() => setIsLoading(false));
        }, 800);
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

    const listContainerVariants = {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
    };
    
    return (
        <Box sx={{ maxWidth: '900px', mx: 'auto', py: { xs: 4, md: 8 } }}>
            {/* --- Hero Section --- */}
            <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5 }}>
                <Typography variant="h3" component="h1" sx={{ textAlign: 'center', mb: 1 }}>
                    Ihre Dashboards
                </Typography>
                <Typography variant="h6" color="text.secondary" sx={{ textAlign: 'center', mb: 6 }}>
                    Organisieren, analysieren und personalisieren Sie Ihre Nachrichten-Feeds.
                </Typography>
            </motion.div>

            {/* --- Action Bar --- */}
             <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4, px: 1 }}>
                <Typography variant="h5" component="h2">
                    Übersicht
                </Typography>
                <Button variant="contained" color="primary" onClick={() => setDialogOpen(true)}>
                    Dashboard erstellen
                </Button>
            </Box>
            
            {error && <Typography color="error" sx={{ my: 2, textAlign: 'center' }}>{error}</Typography>}

            {/* --- Dashboard List --- */}
            <motion.ul variants={listContainerVariants} initial="hidden" animate="visible" style={{ padding: 0 }}>
                {isLoading ? (
                    Array.from(new Array(3)).map((_, index) => (
                        <Skeleton key={index} variant="rectangular" height={90} sx={{ mb: 2, borderRadius: '12px' }} />
                    ))
                ) : (
                    dashboards.map((dashboard) => (
                        <DashboardListItem 
                            key={dashboard.id}
                            dashboard={dashboard}
                            isHovered={hoveredId === dashboard.id}
                            onHoverStart={() => setHoveredId(dashboard.id)}
                            onHoverEnd={() => setHoveredId(null)}
                        />
                    ))
                )}
            </motion.ul>
            
            {!isLoading && dashboards.length === 0 && (
                 <Fade in={true}>
                    <Box sx={{ textAlign: 'center', p: 4, border: '1px dashed', borderColor: 'divider', borderRadius: '12px', mt: 4 }}>
                         <Typography variant="h6">Noch keine Dashboards</Typography>
                         <Typography color="text.secondary" sx={{ mt: 1, mb: 2 }}>
                            Starten Sie, indem Sie Ihr erstes personalisiertes Dashboard erstellen.
                        </Typography>
                         <Button variant="outlined" onClick={() => setDialogOpen(true)}>
                            Jetzt erstellen
                        </Button>
                    </Box>
                </Fade>
            )}

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
        </Box>
    );
}
