'use strict';
/* Question-generator benchmark corpus (owner decision 2026-11-27: sample texts written for the benchmark, none of the owner's files).
   Shaped like a file analysis: sections with a description and key points, exactly what the Learning Question Writer receives. */
module.exports = [
  {
    id: 'econ-supply', title: 'Supply and demand',
    sections: [
      { number: '1', title: 'The law of demand', description: 'The law of demand states that, other things being equal, the quantity demanded of a good falls when its price rises and rises when its price falls.',
        keyPoints: ['A demand curve slopes downward from left to right.', 'A change in price causes a movement along the demand curve, not a shift of the curve.', 'Income, tastes, the prices of related goods and expectations shift the whole demand curve.'] },
      { number: '2', title: 'The law of supply', description: 'The law of supply states that, other things being equal, producers offer a larger quantity of a good for sale at a higher price.',
        keyPoints: ['A supply curve slopes upward from left to right.', 'Input costs, technology and the number of sellers shift the supply curve.', 'An improvement in technology usually shifts the supply curve to the right.'] },
      { number: '3', title: 'Market equilibrium', description: 'Equilibrium is the price at which the quantity demanded equals the quantity supplied, so the market clears.',
        keyPoints: ['Above the equilibrium price there is a surplus, which pushes the price down.', 'Below the equilibrium price there is a shortage, which pushes the price up.', 'A rise in demand with supply unchanged raises both the equilibrium price and quantity.'] },
      { number: '4', title: 'Price controls', description: 'A price ceiling is a legal maximum price; a price floor is a legal minimum price.',
        keyPoints: ['A binding price ceiling is set below the equilibrium price and creates a shortage.', 'A binding price floor is set above the equilibrium price and creates a surplus.', 'Minimum wage laws are an example of a price floor in the labour market.'] },
    ],
  },
  {
    id: 'agrarian', title: 'Agrarian reform',
    sections: [
      { number: '1', title: 'What agrarian reform is', description: 'Agrarian reform is the redistribution of agricultural land, together with support services, so that farmers who till the land can own it.',
        keyPoints: ['It aims to reduce the concentration of land in the hands of a few owners.', 'Land redistribution alone is not enough; farmers also need credit, roads, irrigation and training.', 'It is often justified on grounds of social justice and rural productivity.'] },
      { number: '2', title: 'Tenancy and share-cropping', description: 'Under share-cropping, a tenant farms land owned by a landlord and pays rent with a share of the harvest.',
        keyPoints: ['High harvest shares paid as rent leave tenants little to invest in the land.', 'Leasehold replaces a harvest share with a fixed rent agreed in advance.', 'Insecure tenancy discourages long-term improvements such as irrigation.'] },
      { number: '3', title: 'Compensation of landowners', description: 'When land is acquired for redistribution, the government pays the former owner just compensation.',
        keyPoints: ['Beneficiaries usually pay for the land in yearly instalments over many years.', 'Disputes over the value of land are a common cause of delay.', 'Payment can be made partly in cash and partly in government bonds.'] },
      { number: '4', title: 'Support services', description: 'Support services help land reform beneficiaries farm productively after they receive land.',
        keyPoints: ['Cooperatives let small farmers buy inputs and sell crops together.', 'Without credit, new owners may sell or mortgage their land again.', 'Extension workers teach farming methods and help farmers adopt new technology.'] },
    ],
  },
  {
    id: 'bonding', title: 'Chemical bonding',
    sections: [
      { number: '1', title: 'Ionic bonds', description: 'An ionic bond forms when electrons are transferred from a metal atom to a non-metal atom, producing oppositely charged ions that attract each other.',
        keyPoints: ['Sodium chloride is held together by ionic bonds.', 'Ionic compounds form a giant lattice of ions.', 'Ionic compounds conduct electricity when molten or dissolved, because the ions can move.'] },
      { number: '2', title: 'Covalent bonds', description: 'A covalent bond is a shared pair of electrons between two non-metal atoms.',
        keyPoints: ['A water molecule contains two covalent bonds between oxygen and hydrogen.', 'A double bond is two shared pairs of electrons.', 'Simple molecular substances have low melting points because the forces between molecules are weak.'] },
      { number: '3', title: 'Metallic bonds', description: 'In a metal, positive metal ions are held in a lattice by a sea of delocalised electrons.',
        keyPoints: ['Delocalised electrons let metals conduct electricity as solids.', 'Layers of ions can slide over each other, so metals are malleable.', 'Metals generally have high melting points.'] },
      { number: '4', title: 'Electronegativity', description: 'Electronegativity is the ability of an atom to attract the shared electrons in a covalent bond.',
        keyPoints: ['Fluorine is the most electronegative element.', 'A large difference in electronegativity between two atoms makes a bond polar.', 'When the difference is very large, the bond is better described as ionic.'] },
    ],
  },
  {
    id: 'photosynthesis', title: 'Photosynthesis',
    sections: [
      { number: '1', title: 'Overview', description: 'Photosynthesis is the process in which plants use light energy to make glucose from carbon dioxide and water, releasing oxygen.',
        keyPoints: ['It takes place in the chloroplasts of plant cells.', 'Chlorophyll absorbs mainly red and blue light and reflects green light.', 'The oxygen released comes from the splitting of water molecules.'] },
      { number: '2', title: 'Light-dependent reactions', description: 'The light-dependent reactions take place in the thylakoid membranes and convert light energy into chemical energy.',
        keyPoints: ['They produce ATP and NADPH.', 'Water is split in these reactions, a step called photolysis.', 'They need light and stop in the dark.'] },
      { number: '3', title: 'The Calvin cycle', description: 'The Calvin cycle takes place in the stroma and uses ATP and NADPH to fix carbon dioxide into sugar.',
        keyPoints: ['The enzyme RuBisCO fixes carbon dioxide.', 'The Calvin cycle does not use light directly.', 'It produces a three-carbon sugar that the plant uses to build glucose.'] },
      { number: '4', title: 'Limiting factors', description: 'The rate of photosynthesis is limited by whichever factor is in shortest supply.',
        keyPoints: ['Light intensity, carbon dioxide concentration and temperature are the main limiting factors.', 'Above an optimum temperature the rate falls because enzymes are damaged.', 'Greenhouses raise yields by increasing carbon dioxide, light and warmth.'] },
    ],
  },
];
