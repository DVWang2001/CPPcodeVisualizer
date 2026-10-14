// UML 物件圖教案 CC-2603B：分數向量的總和、乘積與平均（FVec 提供 push 與 reduce）
// （改寫自 CF 題目 CC-2603B：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<vector>
using namespace std;
int gcd(int a,int b){
   if(a<0)a=-a;
   if(b<0)b=-b;
   return b==0?a:gcd(b,a%b);
}
class Fraction{public:
   int x,y;
   Fraction(int a=0,int b=0):x(a),y(b){}
   Fraction add(Fraction b){
      return Fraction(x*b.y+y*b.x,y*b.y);
   }
   Fraction mul(Fraction b){
      return Fraction(x*b.x,y*b.y);
   }
   Fraction div(int b){
      return Fraction(x,y*b);
   }
   void read(){char c;cin>>x>>c>>y;}
   void print(){cout<<x<<"/"<<y;}
};

class FVec{
   vector<Fraction>fv;
public:
   void push(Fraction f){fv.push_back(f);}
   Fraction reduce(Fraction f)const{
      int g=gcd(f.x,f.y);
      if(g==0) g=1;
      return Fraction(f.x/g, f.y/g);
   }
   Fraction sum(){
      Fraction s=fv[0];
      for(int i=1;i<fv.size();i++) s=s.add(fv[i]);
      return reduce(s);
   }
   Fraction pro(){
      Fraction p=fv[0];
      for(int i=1;i<fv.size();i++) p=p.mul(fv[i]);
      return reduce(p);
   }
   Fraction avg(){
      return reduce(sum().div((int)fv.size()));
   }
   void read(){
      int n;cin>>n;
      for(int i=0;i<n;i++){Fraction f;f.read();push(f);}
   }
};
int main(){
  FVec a;a.read();
  a.sum().print();cout<<endl;a.pro().print();cout<<endl;a.avg().print();cout<<endl;  //@ @guide uml:a
  return 0;
}
