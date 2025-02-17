import { z } from 'zod'
import { Agent } from '@openserv-labs/sdk'
import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createWorker } from 'tesseract.js'

interface Product {
  name: string;
  category: string;
  price?: string;
  description?: string;
  rating?: string;
  url: string;
}

interface Category {
  name: string;
  description?: string;
  products: Product[];
}

// Create the agent with updated system prompt
const agent = new Agent({
  systemPrompt: `You are a sophisticated web crawling agent that:
  1. Creates structured summaries of websites
  2. Extracts and organizes product information
  3. Performs price comparisons and analysis
  4. Identifies key navigation elements and site structure
  5. Makes websites accessible through clear text descriptions`
})

// Enhanced web crawling capability
agent.addCapability({
  name: 'analyzeSite',
  description: 'Analyzes website content and structure, extracting product information and categories',
  schema: z.object({
    url: z.string().url(),
    includeProducts: z.boolean().optional(),
  }),
  async run({ args }) {
    const browser = await puppeteer.launch({ headless: true })
    const page = await browser.newPage()
    
    try {
      await page.goto(args.url, { waitUntil: 'networkidle0' })
      
      const siteData = await page.evaluate(() => {
        // Helper function to clean text
        const cleanText = (text: string) => text.trim().replace(/\s+/g, ' ');

        // Extract categories
        const categories: Category[] = [];
        const categoryElements = document.querySelectorAll('.category, [data-type="category"]');
        
        categoryElements.forEach((catEl: Element) => {
          const category: Category = {
            name: cleanText(catEl.querySelector('h2, h3')?.textContent || ''),
            description: cleanText(catEl.querySelector('.description')?.textContent || ''),
            products: []
          };

          // Extract products within category
          const productElements = catEl.querySelectorAll('.product, [data-type="product"]');
          productElements.forEach((prodEl: Element) => {
            const product: Product = {
              name: cleanText(prodEl.querySelector('.product-name, h3')?.textContent || ''),
              category: category.name,
              price: cleanText(prodEl.querySelector('.price')?.textContent || ''),
              description: cleanText(prodEl.querySelector('.description')?.textContent || ''),
              rating: cleanText(prodEl.querySelector('.rating')?.textContent || ''),
              url: (prodEl.querySelector('a')?.getAttribute('href') || ''),
            };
            category.products.push(product);
          });

          categories.push(category);
        });

        // Extract navigation structure
        const navigation = Array.from(document.querySelectorAll('nav a')).map(a => ({
          text: cleanText(a.textContent || ''),
          url: a.getAttribute('href')
        }));

        return {
          title: document.title,
          categories,
          navigation,
          mainContent: cleanText(document.querySelector('main')?.textContent || '')
        };
      });

      await browser.close();

      // Format the output
      let summary = `Website: ${siteData.title}\n\n`;
      summary += `Navigation Structure:\n${siteData.navigation.map(nav => `- ${nav.text}`).join('\n')}\n\n`;
      
      if (siteData.categories.length > 0) {
        summary += 'Product Categories:\n\n';
        siteData.categories.forEach(cat => {
          summary += `${cat.name}\n${'-'.repeat(cat.name.length)}\n`;
          if (cat.description) summary += `Description: ${cat.description}\n`;
          
          if (cat.products.length > 0) {
            summary += '\nProducts:\n';
            cat.products.forEach(prod => {
              summary += `\n• ${prod.name}`;
              if (prod.price) summary += `\n  Price: ${prod.price}`;
              if (prod.description) summary += `\n  Description: ${prod.description}`;
              if (prod.rating) summary += `\n  Rating: ${prod.rating}`;
            });
            summary += '\n';
          }
          summary += '\n';
        });

        // Add price analysis if products exist
        const allProducts = siteData.categories.flatMap(cat => cat.products);
        if (allProducts.length > 0) {
          const prices = allProducts
            .filter(p => p.price)
            .map(p => ({ name: p.name, price: parseFloat(p.price?.replace(/[^0-9.]/g, '') || '0') }));
          
          if (prices.length > 0) {
            const cheapest = prices.reduce((min, p) => p.price < min.price ? p : min);
            const mostExpensive = prices.reduce((max, p) => p.price > max.price ? p : max);
            
            summary += '\nPrice Analysis:\n';
            summary += `Most Affordable: ${cheapest.name} at ${cheapest.price}\n`;
            summary += `Premium Option: ${mostExpensive.name} at ${mostExpensive.price}\n`;
          }
        }
      }

      return summary;
      
    } catch (error: unknown) {
      await browser.close();
      return `Error analyzing site: ${error instanceof Error ? error.message : 'Unknown error occurred'}`;
    }
  }
});

// Add OCR capability
agent.addCapability({
  name: 'extractTextFromImage',
  description: 'Extracts text from images on a webpage using OCR',
  schema: z.object({
    url: z.string().url(),
    imageSelector: z.string().optional(),
  }),
  async run({ args }) {
    const browser = await puppeteer.launch({ headless: true })
    const page = await browser.newPage()
    
    try {
      await page.goto(args.url, { waitUntil: 'networkidle0' })
      
      // Get images from the page
      const images = await page.evaluate((selector: string | undefined) => {
        const imgs = selector 
          ? Array.from(document.querySelectorAll(selector)) as HTMLImageElement[]
          : Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
        return imgs
          .map(img => img.src)
          .filter(src => src.startsWith('http')); // Only valid URLs
      }, args.imageSelector);

      // Initialize Tesseract worker
      const worker = await createWorker('eng');
      const results = [];

      // Process each image
      for (const imageUrl of images) {
        try {
          const { data: { text } } = await worker.recognize(imageUrl);
          if (text.trim()) {
            results.push({
              imageUrl,
              text: text.trim()
            });
          }
        } catch (error) {
          console.error(`Failed to process image ${imageUrl}:`, error);
        }
      }

      await worker.terminate();
      await browser.close();
      
      return results.map(r => 
        `Image ${r.imageUrl}:\n${r.text}`
      ).join('\n\n')
      
    } catch (error: unknown) {
      await browser.close()
      return `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`
    }
  }
})

// Start the agent's HTTP server
agent.start()

// Update main function
async function main() {
  const result = await agent.process({
    messages: [
      {
        role: 'user',
        content: 'Analyze https://www.fractal-design.com/products/cases/ and provide a structured summary'
      }
    ]
  });

  console.log(result.choices[0].message.content);
}

main().catch(console.error)
