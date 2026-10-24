import json,time,urllib.request,urllib.error
F="code,product_name,product_name_de,brands,quantity,labels_tags,ingredients_analysis_tags,ingredients,ingredients_text,ingredients_text_de,categories_tags,categories_hierarchy,image_ingredients_url,image_front_small_url,generic_name,generic_name_de"
codes=[p['code'] for p in json.load(open('sample.json'))]
out=[]; miss=0
for c in codes:
    for attempt in range(6):
        try:
            req=urllib.request.Request(f"https://world.openfoodfacts.org/api/v2/product/{c}.json?fields={F}",headers={"User-Agent":"VeganCheck-eval/1.0 (robertkrause2022)"})
            d=json.load(urllib.request.urlopen(req,timeout=15))
            if d.get('product'): out.append(d['product'])
            else: miss+=1
            break
        except urllib.error.HTTPError as e:
            if e.code==404: miss+=1; break
            time.sleep(15)
        except Exception: time.sleep(5)
    time.sleep(1.1)
json.dump(out,open('full.json','w'))
print('fetched',len(out),'missing',miss)
